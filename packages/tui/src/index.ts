import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { stdin as input, stdout as output } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { resolveSettings } from "@herzen/core/settings/registry";
import {
	createFeedReaders,
	type ActionFeedEntry,
	type CoreStatusSnapshot,
	type CoreRuntimeStatus,
	type PerfSummarySnapshot,
	type SessionFeedEntry,
} from "./feeds.js";
import { truncateAnsi, wrapAnsi } from "./ansi_layout.js";
import { TerminalViewport } from "./terminal_viewport.js";
import {
	loadRuntimeOverrides,
	runtimeSettingsFilePath,
	resolveRuntimeSettingItems,
	saveRuntimeOverrides,
	setRuntimeSettingOverride,
	type RuntimeSettingItem,
} from "./runtime_settings.js";

type Panel = "chat" | "actions" | "perf" | "settings";
type StatusLevel = "info" | "warn" | "error";
type IngressStatus = "queued" | "accepted" | "processed" | "failed";
type InputMode = "insert" | "normal";
type RuntimeProfile = "voice" | "text" | "hybrid";

interface IngressState {
	ingressId: string;
	source: "tui" | "automation";
	status: IngressStatus;
	textPreview: string;
	updatedAtMs: number;
	errorCode?: string;
	errorMessage?: string;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_WHITE = "\x1b[37m";

const FAST_POLL_MS = 180;
const PERF_POLL_MS = 1200;
const INGRESS_RETENTION_MS = 12_000;
const INGRESS_ACCEPT_TIMEOUT_MS = 8_000;
const MAX_INGRESS_STATES = 80;
const MAX_ACK_KEYS = 2_000;

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

function resolveDataRoot(rawValue = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawValue?.trim();
	if (!trimmed) return defaultDataRoot;
	return resolve(trimmed);
}

async function main(): Promise<void> {
	const dataRoot = resolveDataRoot();
	const settingsFile = runtimeSettingsFilePath(dataRoot);
	const feeds = createFeedReaders(dataRoot);
	const viewport = new TerminalViewport(output);
	let runtimeOverrides = loadRuntimeOverrides(settingsFile);

	let panel: Panel = "chat";
	let inputMode: InputMode = "insert";
	let composer = "";
	let selectedSettingIndex = 0;
	let sessionFeed: SessionFeedEntry[] = [];
	let actionFeed: ActionFeedEntry[] = [];
	let perfSummary: PerfSummarySnapshot = { totalEvents: 0, phases: [] };
	let coreRuntimeStatus: CoreRuntimeStatus = { online: false, status: null };
	let settingItems: RuntimeSettingItem[] = resolveRuntimeSettingItems(process.env, runtimeOverrides);
	let currentSessionId = "";
	let statusMessage = "ready";
	let statusLevel: StatusLevel = "info";
	let saving = false;
	let settingError = "";
	let running = true;
	let refreshInFlight = false;
	let lastPerfPollAtMs = 0;
	let exitCode = 0;
	let fatalError: unknown = null;

	const ingressStates = new Map<string, IngressState>();
	const seenIngressAckKeys = new Set<string>();
	const ingressAckQueue: string[] = [];

	const updateStatus = (level: StatusLevel, message: string): void => {
		statusLevel = level;
		statusMessage = message;
	};

	const pruneIngressState = (): void => {
		const nowMs = Date.now();
		for (const state of ingressStates.values()) {
			if (state.status !== "queued") continue;
			if (nowMs - state.updatedAtMs <= INGRESS_ACCEPT_TIMEOUT_MS) continue;
			state.status = "failed";
			state.errorCode = "INGRESS_TIMEOUT";
			state.errorMessage = "No ingress consumer acknowledged this event.";
			state.updatedAtMs = nowMs;
			updateStatus(
				"warn",
				`ingress ${shortIngressId(state.ingressId)} timeout (is core running?)`,
			);
		}

		for (const [ingressId, state] of ingressStates.entries()) {
			const terminal = state.status === "processed" || state.status === "failed";
			if (!terminal) continue;
			if (nowMs - state.updatedAtMs <= INGRESS_RETENTION_MS) continue;
			ingressStates.delete(ingressId);
		}
		while (ingressStates.size > MAX_INGRESS_STATES) {
			const firstKey = ingressStates.keys().next().value as string | undefined;
			if (!firstKey) break;
			ingressStates.delete(firstKey);
		}
	};

	const noteIngressAck = (key: string): boolean => {
		if (seenIngressAckKeys.has(key)) return false;
		seenIngressAckKeys.add(key);
		ingressAckQueue.push(key);
		while (ingressAckQueue.length > MAX_ACK_KEYS) {
			const oldest = ingressAckQueue.shift();
			if (!oldest) break;
			seenIngressAckKeys.delete(oldest);
		}
		return true;
	};

	const applyIngressLifecycle = (entries: ActionFeedEntry[]): void => {
		for (const entry of entries) {
			if (!entry.ingressId || !entry.phase) continue;
			if (entry.phase !== "ingress_accepted" && entry.phase !== "ingress_processed") continue;

			const ackKey = `${entry.ts ?? ""}:${entry.phase}:${entry.ingressId}:${entry.ok === false ? "0" : "1"}:${entry.code ?? ""}`;
			if (!noteIngressAck(ackKey)) continue;

			const current = ingressStates.get(entry.ingressId);
			if (!current) continue;

			if (entry.phase === "ingress_accepted") {
				current.status = "accepted";
				current.updatedAtMs = Date.now();
				updateStatus("info", `ingress ${shortIngressId(current.ingressId)} accepted`);
				continue;
			}

			current.status = entry.ok === false ? "failed" : "processed";
			current.errorCode = entry.code || undefined;
			current.errorMessage = entry.message || undefined;
			current.updatedAtMs = Date.now();
			if (entry.ok === false) {
				updateStatus(
					"error",
					`ingress ${shortIngressId(current.ingressId)} failed${current.errorCode ? ` (${current.errorCode})` : ""}`,
				);
			} else {
				updateStatus("info", `ingress ${shortIngressId(current.ingressId)} processed`);
			}
		}
	};

	const render = (): void => {
		const width = Math.max(60, output.columns ?? 100);
		const rows = Math.max(20, output.rows ?? 32);
		const mainHeight = Math.max(8, rows - 8);
		const model = process.env.HERZEN_OLLAMA_MODEL?.trim() || "unconfigured";
		const coreOnline = coreRuntimeStatus.online;
		const coreState = coreRuntimeStatus.status?.coreState ?? "offline";
		const activeProfile = coreRuntimeStatus.status?.profile ?? "-";
		const resolvedSettings = resolveSettings({
			...process.env,
			...runtimeOverrides,
		});
		const runtimeState = `core:${coreOnline ? "online" : "offline"}(${coreState})`;
		const headerSession = coreRuntimeStatus.status?.sessionId || currentSessionId || "-";
		const ingressItems = [...ingressStates.values()].sort((left, right) => left.updatedAtMs - right.updatedAtMs);
		const pendingCount = ingressItems.filter(
			(item) => item.status === "queued" || item.status === "accepted",
		).length;

		const panelLines = renderPanel(panel, {
			sessionFeed,
			actionFeed,
			perfSummary,
			coreStatus: coreRuntimeStatus.status,
			settingItems,
			selectedSettingIndex,
			settingError,
			saving,
			inputMode,
			userName: resolvedSettings.tui.userName,
		});
		let visiblePanelLines: string[];
		if (panel === "chat") {
			const chatHeaderLineCount = coreRuntimeStatus.status ? 3 : 1;
			const pinnedTopLines = [
				...renderIngressFrame(ingressItems),
				"",
				...panelLines.slice(0, chatHeaderLineCount),
			].flatMap((line) => wrapAnsi(line, width));
			const chatBodyLines = panelLines
				.slice(chatHeaderLineCount)
				.flatMap((line) => wrapAnsi(line, width));

			if (pinnedTopLines.length >= mainHeight) {
				visiblePanelLines = pinnedTopLines.slice(0, mainHeight);
			} else {
				const chatBodyHeight = mainHeight - pinnedTopLines.length;
				const visibleBodyLines = chatBodyLines.slice(-chatBodyHeight);
				while (visibleBodyLines.length < chatBodyHeight) {
					visibleBodyLines.unshift("");
				}
				visiblePanelLines = [...pinnedTopLines, ...visibleBodyLines];
			}
		} else {
			const wrappedPanelLines = panelLines.flatMap((line) => wrapAnsi(line, width));
			visiblePanelLines = wrappedPanelLines.slice(-mainHeight);
			while (visiblePanelLines.length < mainHeight) {
				visiblePanelLines.unshift("");
			}
		}

		const footer = `${runtimeState} | ingress_pending=${pendingCount} | ${statusMessage}`;
		const composerLine = `> ${composer}`;
		const tabs = renderTabs(panel, inputMode);
		const modeHints =
			inputMode === "insert" ?
				"Mode: INSERT  Enter=send  Esc=normal  Ctrl+C=quit"
			:	"Mode: NORMAL  i=insert  1/2/3/s panel  v/t/h profile  r voice-once  w wakeword  j/k setting  Enter=apply(setting)  q=quit";
		const lines = [
			`${ANSI_CYAN}Herzen Operator TUI v0.0.1${ANSI_RESET}`,
			`${ANSI_DIM}${fitToWidth(`session=${headerSession}  core=${coreOnline ? "online" : "offline"}  profile=${activeProfile}  model=${model}  data=${dataRoot}  input=${inputMode}`, width)}${ANSI_RESET}`,
			fitToWidth(tabs, width),
			"-".repeat(width),
			...visiblePanelLines,
			"-".repeat(width),
			`${ANSI_DIM}${fitToWidth(modeHints, width)}${ANSI_RESET}`,
			fitToWidth(composerLine, width),
			colorByStatus(fitToWidth(footer, width), statusLevel),
		];
		viewport.render(`${lines.join("\n")}\n`);
	};

	const refresh = async (options: { forcePerf?: boolean } = {}): Promise<void> => {
		if (refreshInFlight) return;
		refreshInFlight = true;
		try {
			sessionFeed = await feeds.pollSessionFeed();
			currentSessionId = feeds.getActiveSessionId();
			actionFeed = await feeds.pollActionFeed();
			applyIngressLifecycle(actionFeed);
			coreRuntimeStatus = await feeds.pollCoreStatus();

			const nowMs = Date.now();
			if (options.forcePerf || nowMs - lastPerfPollAtMs >= PERF_POLL_MS) {
				perfSummary = await feeds.pollPerfSummary();
				lastPerfPollAtMs = nowMs;
			}

			pruneIngressState();
			settingItems = resolveRuntimeSettingItems(process.env, runtimeOverrides);
			if (selectedSettingIndex >= settingItems.length) {
				selectedSettingIndex = Math.max(0, settingItems.length - 1);
			}
			render();
		} finally {
			refreshInFlight = false;
		}
	};

	const sendComposer = async (): Promise<void> => {
		const text = composer.trim();
		if (!text) return;
		if (!coreRuntimeStatus.online || !coreRuntimeStatus.status) {
			updateStatus("error", "core offline; start pnpm dev first");
			render();
			return;
		}
		const sessionId = coreRuntimeStatus.status.sessionId || currentSessionId;
		if (!sessionId) {
			updateStatus("error", "no active session; wait for core heartbeat");
			render();
			return;
		}
		try {
			const ingress = await appendChatIngressEvent(dataRoot, {
				sessionId,
				text,
			});
			ingressStates.set(ingress.ingressId, {
				ingressId: ingress.ingressId,
				source: ingress.source,
				status: "queued",
				textPreview: ingress.text,
				updatedAtMs: Date.now(),
			});
			composer = "";
			updateStatus("info", `ingress ${shortIngressId(ingress.ingressId)} queued`);
			render();
		} catch (err) {
			updateStatus("error", `failed to send: ${err instanceof Error ? err.message : String(err)}`);
			render();
		}
	};

	const applySelectedSetting = async (): Promise<void> => {
		const setting = settingItems[selectedSettingIndex];
		if (!setting) return;

		let nextValue: string;
		if (setting.key === "logging.level") {
			nextValue = cycleLogLevel(setting.value);
		} else if (setting.value === "true" || setting.value === "false") {
			nextValue = setting.value === "true" ? "false" : "true";
		} else {
			settingError = "selected setting is not toggleable in TUI";
			updateStatus("warn", "setting unchanged");
			render();
			return;
		}

		const candidateOverrides = setRuntimeSettingOverride(runtimeOverrides, setting.key, nextValue);
		const candidateItems = resolveRuntimeSettingItems(process.env, candidateOverrides);
		const resolved = candidateItems.find((item) => item.key === setting.key);
		if (!resolved || resolved.value !== nextValue) {
			settingError = `invalid value for ${setting.key}: ${nextValue}`;
			updateStatus("error", "settings validation failed");
			render();
			return;
		}

		settingError = "";
		saving = true;
		render();
		try {
			await saveRuntimeOverrides(settingsFile, candidateOverrides);
			runtimeOverrides = candidateOverrides;
			updateStatus("info", `saved ${setting.key}=${nextValue}`);
		} catch (err) {
			settingError = err instanceof Error ? err.message : String(err);
			updateStatus("error", "failed to save runtime settings");
		} finally {
			saving = false;
			render();
		}
	};

	const queueIngressState = (ingress: {
		ingressId: string;
		source: "tui";
		description: string;
	}): void => {
		ingressStates.set(ingress.ingressId, {
			ingressId: ingress.ingressId,
			source: ingress.source,
			status: "queued",
			textPreview: ingress.description,
			updatedAtMs: Date.now(),
		});
		updateStatus("info", `ingress ${shortIngressId(ingress.ingressId)} queued`);
	};

	const sendRuntimeControl = async (
		command:
			| { command: "runtime.set_profile"; payload: { profile: RuntimeProfile } }
			| { command: "voice.trigger_once"; payload: Record<string, never> }
			| { command: "wakeword.set_enabled"; payload: { enabled: boolean } },
	): Promise<void> => {
		if (!coreRuntimeStatus.online || !coreRuntimeStatus.status) {
			updateStatus("error", "core offline; command not sent");
			render();
			return;
		}
		const sessionId = coreRuntimeStatus.status.sessionId || currentSessionId;
		if (!sessionId) {
			updateStatus("error", "no session id in heartbeat");
			render();
			return;
		}
		try {
			const ingress =
				command.command === "runtime.set_profile" ?
					await appendControlIngressEvent(dataRoot, {
						sessionId,
						command: "runtime.set_profile",
						payload: { profile: command.payload.profile },
					})
				: command.command === "wakeword.set_enabled" ?
					await appendControlIngressEvent(dataRoot, {
						sessionId,
						command: "wakeword.set_enabled",
						payload: { enabled: command.payload.enabled },
					})
				:	await appendControlIngressEvent(dataRoot, {
						sessionId,
						command: "voice.trigger_once",
						payload: {},
					});
			const description =
				command.command === "runtime.set_profile" ?
					`[cmd] runtime.set_profile ${command.payload.profile}`
				: command.command === "wakeword.set_enabled" ?
					`[cmd] wakeword.set_enabled ${command.payload.enabled ? "true" : "false"}`
				:	"[cmd] voice.trigger_once";
			queueIngressState({
				ingressId: ingress.ingressId,
				source: ingress.source,
				description,
			});
			render();
		} catch (err) {
			updateStatus("error", `command failed: ${err instanceof Error ? err.message : String(err)}`);
			render();
		}
	};

	const setRuntimeProfile = (profile: RuntimeProfile): void => {
		void sendRuntimeControl({
			command: "runtime.set_profile",
			payload: { profile },
		}).then(() => refresh());
	};

	const triggerVoiceOnce = (): void => {
		void sendRuntimeControl({
			command: "voice.trigger_once",
			payload: {},
		}).then(() => refresh());
	};

	const toggleWakeword = (): void => {
		const status = coreRuntimeStatus.status;
		const current = status?.wakewordState === "ready";
		void sendRuntimeControl({
			command: "wakeword.set_enabled",
			payload: { enabled: !current },
		}).then(() => refresh());
	};

	const requestStop = (code: number, err?: unknown): void => {
		running = false;
		exitCode = code;
		if (err !== undefined) {
			fatalError = err;
		}
	};

	const onKeypress = (chunk: Buffer): void => {
		const key = chunk.toString("utf8");
		if (key === "\u0003") {
			requestStop(0);
			return;
		}

		if (inputMode === "insert") {
			if (key === "\x1b") {
				inputMode = "normal";
				updateStatus("info", "normal mode");
				render();
				return;
			}
			if (key === "\r") {
				void sendComposer().then(() => refresh());
				return;
			}
			if (key === "\u007f") {
				composer = composer.slice(0, -1);
				render();
				return;
			}
			if (isPrintableInput(key)) {
				composer += key;
				render();
			}
			return;
		}

		if (key === "i") {
			inputMode = "insert";
			panel = "chat";
			updateStatus("info", "insert mode");
			render();
			return;
		}
		if (key === "q") {
			requestStop(0);
			return;
		}
		if (key === "v") {
			setRuntimeProfile("voice");
			return;
		}
		if (key === "t") {
			setRuntimeProfile("text");
			return;
		}
		if (key === "h") {
			setRuntimeProfile("hybrid");
			return;
		}
		if (key === "r") {
			triggerVoiceOnce();
			return;
		}
		if (key === "w") {
			toggleWakeword();
			return;
		}
		if (key === "1") panel = "chat";
		if (key === "2") panel = "actions";
		if (key === "3") panel = "perf";
		if (key === "s") panel = "settings";

		if (panel === "settings") {
			if (key === "j" || key === "\x1b[B") {
				selectedSettingIndex = Math.min(settingItems.length - 1, selectedSettingIndex + 1);
			}
			if (key === "k" || key === "\x1b[A") {
				selectedSettingIndex = Math.max(0, selectedSettingIndex - 1);
			}
		}
		if (key === "\r" && panel === "settings") {
			void applySelectedSetting().then(() => refresh());
			return;
		}
		render();
	};

	const onSignal = (): void => {
		requestStop(0);
	};
	const onUnhandledError = (err: unknown): void => {
		requestStop(1, err);
	};
	const onResize = (): void => {
		render();
	};

	const cleanup = (): void => {
		input.off("data", onKeypress);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGWINCH", onResize);
		process.off("uncaughtException", onUnhandledError);
		process.off("unhandledRejection", onUnhandledError);
		input.setRawMode?.(false);
		input.pause();
		viewport.exit();
		output.write("\n");
	};

	input.setRawMode?.(true);
	input.resume();
	input.on("data", onKeypress);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	process.on("SIGWINCH", onResize);
	process.on("uncaughtException", onUnhandledError);
	process.on("unhandledRejection", onUnhandledError);

	try {
		await refresh({ forcePerf: true });
		while (running) {
			await delay(FAST_POLL_MS);
			await refresh();
		}
	} finally {
		cleanup();
	}

	if (fatalError) {
		throw fatalError instanceof Error ? fatalError : new Error(String(fatalError));
	}
	if (exitCode !== 0) {
		throw new Error(`Exited with code ${exitCode}`);
	}
}

function renderPanel(
	panel: Panel,
	state: {
		sessionFeed: SessionFeedEntry[];
		actionFeed: ActionFeedEntry[];
		perfSummary: PerfSummarySnapshot;
		coreStatus: CoreStatusSnapshot | null;
		settingItems: RuntimeSettingItem[];
		selectedSettingIndex: number;
		settingError: string;
		saving: boolean;
		inputMode: InputMode;
		userName: string;
	},
): string[] {
	if (panel === "chat") return renderChatPanel(state.sessionFeed, state.coreStatus, state.userName);
	if (panel === "actions") return renderActionsPanel(state.actionFeed);
	if (panel === "perf") return renderPerfPanel(state.perfSummary);
	return renderSettingsPanel(
		state.settingItems,
		state.selectedSettingIndex,
		state.settingError,
		state.saving,
		state.inputMode,
	);
}

function renderIngressFrame(ingressStates: IngressState[]): string[] {
	const lines: string[] = [];
	lines.push(`${ANSI_WHITE}Ingress${ANSI_RESET}`);
	if (ingressStates.length === 0) {
		lines.push(`${ANSI_DIM}(none)${ANSI_RESET}`);
		return lines;
	}
	for (const ingress of ingressStates.slice(-5)) {
		const stateColor =
			ingress.status === "failed" ? ANSI_RED
			: ingress.status === "processed" ? ANSI_GREEN
			: ANSI_YELLOW;
		const detail =
			ingress.status === "failed" && ingress.errorCode ? ` code=${ingress.errorCode}` : "";
		lines.push(
			`${ANSI_DIM}${shortIngressId(ingress.ingressId)}${ANSI_RESET} ${stateColor}${ingress.status}${ANSI_RESET} ${ANSI_DIM}[${ingress.source}]${ANSI_RESET}${detail} ${ingress.textPreview}`,
		);
	}
	return lines;
}

function renderChatPanel(
	entries: SessionFeedEntry[],
	coreStatus: CoreStatusSnapshot | null,
	userName: string,
): string[] {
	const lines: string[] = [];
	lines.push(`${ANSI_WHITE}Chat${ANSI_RESET}`);
	if (coreStatus) {
		const errorSuffix =
			coreStatus.coreState === "degraded" && coreStatus.lastError ?
				` ${ANSI_RED}${coreStatus.lastError.code}${ANSI_RESET}`
			: "";
		lines.push(
			`${ANSI_DIM}core=${coreStatus.coreState} profile=${coreStatus.profile} trigger=${coreStatus.triggerState} wakeword=${coreStatus.wakewordState}${errorSuffix}${ANSI_RESET}`,
		);
		lines.push("");
	}
	let lastTurn: number | undefined;
	for (const entry of entries) {
		if (
			typeof entry.turn === "number" &&
			entry.turn !== lastTurn &&
			(entry.ingressSource === "voice" || entry.ingressSource === "automation")
		) {
			lastTurn = entry.turn;
			lines.push(`${ANSI_DIM}Turn #${entry.turn}${ANSI_RESET}`);
		}
		const role =
			entry.role === "user" ?
				`${ANSI_CYAN}${userName || "USER"}${ANSI_RESET}`
			: entry.role === "assistant" ? `${ANSI_GREEN}Herzen${ANSI_RESET}`
			: `${ANSI_YELLOW}SYSTEM${ANSI_RESET}`;
		const sourceSuffix = entry.ingressSource ? ` ${ANSI_DIM}[${entry.ingressSource}]${ANSI_RESET}` : "";
		lines.push(`  ${role}${sourceSuffix} ${entry.text}`);
	}
	if (entries.length === 0) {
		lines.push(`${ANSI_DIM}(no transcript entries yet)${ANSI_RESET}`);
	}
	return lines;
}

function renderActionsPanel(entries: ActionFeedEntry[]): string[] {
	const lines: string[] = [];
	lines.push(`${ANSI_WHITE}Actions${ANSI_RESET}`);
	for (const entry of entries) {
		const turn = typeof entry.turn === "number" ? `#${entry.turn}` : "#?";
		const phase = entry.phase || "phase?";
		const status = toActionStatus(phase, entry.ok);
		const code = entry.code ? ` ${entry.code}` : "";
		const ingress = entry.ingressId ? ` ingress=${shortIngressId(entry.ingressId)}` : "";
		const message = entry.message ? ` ${entry.message}` : "";
		lines.push(`${turn} ${status} ${phase}${code}${ingress}${message}`);
	}
	if (entries.length === 0) {
		lines.push(`${ANSI_DIM}(no action events yet)${ANSI_RESET}`);
	}
	return lines;
}

function renderPerfPanel(summary: PerfSummarySnapshot): string[] {
	const lines: string[] = [];
	lines.push(`${ANSI_WHITE}Perf${ANSI_RESET}`);
	lines.push(`events analyzed: ${summary.totalEvents}`);
	if (summary.lastTurn) {
		lines.push(
			`last turn #${summary.lastTurn.turn}: stt=${fmtMs(summary.lastTurn.sttMs)} llm=${fmtMs(summary.lastTurn.llmMs)} tts=${fmtMs(summary.lastTurn.ttsMs)} e2e=${fmtMs(summary.lastTurn.endToEndMs)}`,
		);
	}
	for (const phase of summary.phases) {
		lines.push(`${phase.phase.padEnd(12)} count=${phase.count} avg=${phase.avgDurationMs}ms`);
	}
	if (summary.phases.length === 0) {
		lines.push(`${ANSI_DIM}(no perf events yet)${ANSI_RESET}`);
	}
	return lines;
}

function renderSettingsPanel(
	items: RuntimeSettingItem[],
	selectedIndex: number,
	settingError: string,
	saving: boolean,
	inputMode: InputMode,
): string[] {
	const lines: string[] = [];
	lines.push(`${ANSI_WHITE}Settings${ANSI_RESET}`);
	lines.push(
		`${ANSI_DIM}${inputMode === "normal" ? "NORMAL: j/k move, Enter toggle selected setting, i to type" : "INSERT: Esc to normal mode for j/k + Enter toggle"}${ANSI_RESET}`,
	);
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item) continue;
		const marker = index === selectedIndex ? ">" : " ";
		const mode = item.mutability === "runtime" ? "runtime" : "restart";
		const value = item.sensitive ? "****" : item.value;
		lines.push(`${marker} [${mode}] ${item.key} = ${value}`);
	}
	if (saving) lines.push(`${ANSI_YELLOW}saving...${ANSI_RESET}`);
	if (settingError) lines.push(`${ANSI_RED}${settingError}${ANSI_RESET}`);
	return lines;
}

function renderTabs(active: Panel, inputMode: InputMode): string {
	return [
		tabLabel("1", "Chat", active === "chat", inputMode),
		tabLabel("2", "Actions", active === "actions", inputMode),
		tabLabel("3", "Perf", active === "perf", inputMode),
		tabLabel("s", "Settings", active === "settings", inputMode),
	].join("  ");
}

function tabLabel(key: string, label: string, active: boolean, inputMode: InputMode): string {
	const base = `[${key}] ${label}`;
	if (active) return `${ANSI_GREEN}${base}${ANSI_RESET}`;
	if (inputMode === "insert") return `${ANSI_DIM}${base}${ANSI_RESET}`;
	return base;
}

function toActionStatus(phase: string, ok: boolean | undefined): string {
	if (phase === "ingress_accepted") return `${ANSI_CYAN}accepted${ANSI_RESET}`;
	if (phase === "ingress_processed" && ok === true) return `${ANSI_GREEN}processed${ANSI_RESET}`;
	if (phase === "ingress_processed" && ok === false) return `${ANSI_RED}failed${ANSI_RESET}`;
	if (phase.endsWith("_started")) return `${ANSI_CYAN}started${ANSI_RESET}`;
	if (ok === true) return `${ANSI_GREEN}succeeded${ANSI_RESET}`;
	if (ok === false) return `${ANSI_RED}failed${ANSI_RESET}`;
	return `${ANSI_DIM}unknown${ANSI_RESET}`;
}

function fmtMs(value: number | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "-";
	return `${Math.round(value)}ms`;
}

async function appendControlIngressEvent(
	dataRoot: string,
	inputValue:
		| {
				sessionId: string;
				command: "chat.send";
				payload: {
					sessionId: string;
					text: string;
					source: "tui";
				};
		  }
		| {
				sessionId: string;
				command: "runtime.set_profile";
				payload: {
					profile: RuntimeProfile;
				};
		  }
		| {
				sessionId: string;
				command: "voice.trigger_once";
				payload: Record<string, never>;
		  }
		| {
				sessionId: string;
				command: "wakeword.set_enabled";
				payload: {
					enabled: boolean;
				};
		  },
): Promise<{
	ingressId: string;
	sessionId: string;
	source: "tui";
	ts: string;
}> {
	const controlDir = join(dataRoot, "control");
	const filePath = join(controlDir, "ingress.jsonl");
	const event = {
		schemaVersion: "control.ingress.v1" as const,
		ingressId: randomUUID(),
		sessionId: inputValue.sessionId,
		source: "tui" as const,
		command: inputValue.command,
		payload: inputValue.payload,
		ts: new Date().toISOString(),
	};
	await mkdir(controlDir, { recursive: true });
	await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
	return {
		ingressId: event.ingressId,
		sessionId: event.sessionId,
		source: event.source,
		ts: event.ts,
	};
}

async function appendChatIngressEvent(
	dataRoot: string,
	inputValue: {
		sessionId: string;
		text: string;
	},
): Promise<{
	ingressId: string;
	sessionId: string;
	text: string;
	source: "tui";
	ts: string;
}> {
	const ingress = await appendControlIngressEvent(dataRoot, {
		sessionId: inputValue.sessionId,
		command: "chat.send",
		payload: {
			sessionId: inputValue.sessionId,
			text: inputValue.text,
			source: "tui",
		},
	});
	return {
		...ingress,
		text: inputValue.text,
	};
}

function fitToWidth(value: string, width: number): string {
	return truncateAnsi(value, width);
}

function colorByStatus(value: string, level: StatusLevel): string {
	if (level === "warn") return `${ANSI_YELLOW}${value}${ANSI_RESET}`;
	if (level === "error") return `${ANSI_RED}${value}${ANSI_RESET}`;
	return `${ANSI_DIM}${value}${ANSI_RESET}`;
}

function cycleLogLevel(current: string): string {
	if (current === "info") return "warn";
	if (current === "warn") return "error";
	return "info";
}

function shortIngressId(ingressId: string): string {
	return ingressId.length <= 8 ? ingressId : ingressId.slice(0, 8);
}

function isPrintableInput(value: string): boolean {
	return value.length > 0 && !value.includes("\x1b") && /^[^\p{Cc}\p{Cf}]+$/u.test(value);
}

void main().catch((err) => {
	output.write(`TUI failed: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

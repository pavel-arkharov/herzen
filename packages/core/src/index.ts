import { recordWav, recordAdaptiveWav, playAudio, beep } from "@herzen/audio";
import { createResponseService } from "@herzen/dialog";
import { transcribeWav, SttError } from "@herzen/stt";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { speak } from "@herzen/tts";
import { createDialogJournal, type DialogJournal, type SessionSettingsSnapshot } from "./dialog_journal.js";
import { createLogger, toStructuredSttTurnEntry } from "./logging.js";
import { ConversationContextWindow, resolveContextWindowConfig } from "./context_window.js";
import {
	resolveInitialAdaptiveMaxSecondsInteractive,
	resolveInitialRecordingModeInteractive,
	type RecordingMode,
} from "./recording/factory.js";
import { createRuntime, type RuntimeController } from "./runtime.js";
import {
	createSttTriggerHandler,
	type AssistantUtteranceRecord,
	type ResponseErrorLike,
	type SttLogEntry,
	type UserUtteranceRecord,
} from "./turn.js";
import {
	createTriggerSource,
	resolveInitialTriggerModeInteractive,
	shouldSwitchToStdinAfterWakewordFailure,
} from "./trigger/factory.js";
import { isTriggerError, type TriggerMode, type TriggerSource } from "./trigger/types.js";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");
const DEFAULT_RESPONSE_TEMPERATURE = 0.2;
const DEFAULT_RESPONSE_TIMEOUT_MS = 12_000;

function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

const dataRoot = resolveDataRoot();
const outDir = join(dataRoot, "audio");
const logsDir = join(dataRoot, "logs");
const conversationsDir = join(dataRoot, "conversations");
const runtimeSessionId = randomUUID();
mkdirSync(outDir, { recursive: true });

function resolveFlag(rawValue: string | undefined, fallback: boolean): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return fallback;
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
	return fallback;
}

function resolveNumber(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePositiveInteger(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const logAudioInputEnabled = resolveFlag(process.env.HERZEN_LOG_AUDIO_INPUT, false);

const coreLogger = createLogger({
	logsDir,
	component: "core",
	sessionId: runtimeSessionId,
});

const triggerLogger = createLogger({
	logsDir,
	component: "trigger",
	sessionId: runtimeSessionId,
});

const sttLogger = createLogger({
	logsDir,
	component: "stt",
	sessionId: runtimeSessionId,
});

function asMessage(args: unknown[]): string {
	return format(...args);
}

async function appendSttLog(entry: SttLogEntry): Promise<void> {
	await sttLogger.appendJsonl(
		"stt",
		toStructuredSttTurnEntry(entry, {
			transcriptEnabled: sttLogger.transcriptEnabled,
			audioInputEnabled: logAudioInputEnabled,
			sessionId: runtimeSessionId,
		}),
	);
}

const sttTurnLogger = {
	log: (...args: unknown[]) => {
		sttLogger.info("stt.status", { message: asMessage(args) });
	},
	error: (...args: unknown[]) => {
		sttLogger.error("stt.error", { message: asMessage(args) });
	},
};

const runtimeLogger = {
	log: (...args: unknown[]) => {
		triggerLogger.info("trigger.status", { message: asMessage(args) });
	},
	error: (...args: unknown[]) => {
		triggerLogger.error("trigger.error", { message: asMessage(args) });
	},
};

let runtime: RuntimeController | null = null;
let dialogJournal: DialogJournal | null = null;

async function flushAndExit(code: number): Promise<void> {
	await dialogJournal?.recordSessionEnded({
		reason: code === 0 ? "normal_shutdown" : "runtime_error",
	});
	await Promise.all([
		coreLogger.drain(),
		triggerLogger.drain(),
		sttLogger.drain(),
		dialogJournal?.drain() ?? Promise.resolve(),
	]);
	process.exit(code);
}

async function recordWithProgress(file: string, seconds: number): Promise<void> {
	const startedAt = Date.now();
	const barWidth = 26;

	const render = (forceDone = false) => {
		const elapsedSeconds = forceDone ? seconds : Math.min((Date.now() - startedAt) / 1000, seconds);
		const ratio = Math.max(0, Math.min(1, elapsedSeconds / seconds));
		const filled = Math.round(barWidth * ratio);
		const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
		process.stdout.write(`\rRecording [${bar}] ${elapsedSeconds.toFixed(1)}s/${seconds.toFixed(1)}s`);
		if (forceDone) process.stdout.write("\n");
	};

	render(false);
	const ticker = setInterval(() => render(false), 100);

	try {
		await recordWav(file, seconds);
	} finally {
		clearInterval(ticker);
		render(true);
	}
}

function createHandleTrigger(
	recordingMode: RecordingMode,
	envOverrides: NodeJS.ProcessEnv,
	journal: DialogJournal | null,
): () => Promise<void> {
	const getRuntimeEnv = () => ({ ...process.env, ...envOverrides });
	const contextConfig = resolveContextWindowConfig(getRuntimeEnv(), {
		warn: (...args: unknown[]) => {
			coreLogger.warn("core.context_window_config", { message: asMessage(args) });
		},
	});
	const contextWindow = new ConversationContextWindow(contextConfig);
	const responseService = resolveResponseService(getRuntimeEnv());
	const onUserUtterance = async (event: UserUtteranceRecord) => {
		await journal?.recordUserUtterance(event);
	};
	const onAssistantUtterance = async (event: AssistantUtteranceRecord) => {
		await journal?.recordAssistantUtterance(event);
	};
	const onError = async (event: {
		turn: number;
		stage: "stt" | "response" | "telemetry";
		code?: string;
		message: string;
		details?: Record<string, unknown>;
	}) => {
		await journal?.recordError(event);
	};

	return createSttTriggerHandler({
		outDir,
		getEnv: getRuntimeEnv,
		now: () => Date.now(),
		nowIso: () => new Date().toISOString(),
		logger: sttTurnLogger,
		recordingMode,
		recordAudioFixed: async (file, seconds) => {
			await beep();
			await recordWithProgress(file, seconds);
		},
		recordAudioAdaptive: async (file, config) => {
			const env = getRuntimeEnv();
			await beep();
			return recordAdaptiveWav(file, {
				...config,
				modelPath: env.HERZEN_VAD_MODEL,
				dataDir: env.HERZEN_DATA_DIR,
			});
		},
		transcribeWav,
		isSttError: (err): err is SttError => err instanceof SttError,
		generateResponse: responseService
			? (input) => {
					return responseService.generateReply(input);
				}
			: undefined,
		isResponseError,
		getConversationContext: () => contextWindow.snapshot(),
		onTurnOutcome: (outcome) => {
			if (!outcome.hasTranscript || !outcome.transcript) return;

			contextWindow.appendUser(
				outcome.turn,
				outcome.transcript,
				normalizeContextLanguage(outcome.detectedLanguage),
			);
			if (outcome.assistantSource !== "model") return;
			contextWindow.appendAssistant(outcome.turn, outcome.assistantText, outcome.assistantLanguage);
		},
		onUserUtterance,
		onAssistantUtterance,
		onError,
		appendSttLog,
		playAudio,
		speak,
	});
}

function resolveResponseService(env: NodeJS.ProcessEnv) {
	try {
		return createResponseService({ env });
	} catch (err) {
		if (isResponseError(err)) {
			sttTurnLogger.error(`LLM response disabled (${err.code}): ${err.message}`);
		} else {
			sttTurnLogger.error("Failed to initialize LLM response service:", err);
		}
		return null;
	}
}

function isResponseError(err: unknown): err is ResponseErrorLike {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof (err as { code: unknown }).code === "string" &&
		"message" in err &&
		typeof (err as { message: unknown }).message === "string"
	);
}

function normalizeContextLanguage(rawLanguage: string | undefined): "en" | "ru" | undefined {
	const normalized = rawLanguage?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized.startsWith("ru")) return "ru";
	if (normalized.startsWith("en")) return "en";
	return undefined;
}

interface StartupTriggerRuntimeConfig {
	triggerMode: TriggerMode;
	createSource: (mode: TriggerMode) => TriggerSource;
	recordingMode: RecordingMode;
	recordEnvOverrides: NodeJS.ProcessEnv;
}

async function resolveStartupTriggerRuntimeConfig(): Promise<StartupTriggerRuntimeConfig> {
	const recordingMode = await resolveInitialRecordingModeInteractive();
	const recordEnvOverrides: NodeJS.ProcessEnv = {};
	if (recordingMode === "adaptive") {
		const adaptiveMaxSeconds = await resolveInitialAdaptiveMaxSecondsInteractive({
			rawMaxSeconds: process.env.HERZEN_RECORD_MAX_SECONDS,
			defaultMaxSeconds: 60,
		});
		recordEnvOverrides.HERZEN_RECORD_MAX_SECONDS = String(adaptiveMaxSeconds);
	}

	const selectedMode = await resolveInitialTriggerModeInteractive();
	if (selectedMode !== "wakeword") {
		return {
			triggerMode: selectedMode,
			createSource: createTriggerSource,
			recordingMode,
			recordEnvOverrides,
		};
	}

	const wakewordSource = createTriggerSource("wakeword");
	try {
		await wakewordSource.start();
			return {
				triggerMode: "wakeword",
				createSource: (mode) => {
					if (mode !== "wakeword") return createTriggerSource(mode);
					return createPrestartedSource(wakewordSource);
				},
				recordingMode,
				recordEnvOverrides,
			};
		} catch (err) {
		if (isTriggerError(err) && (err.code === "SOURCE_FAILED" || err.code === "SOURCE_CLOSED")) {
			process.stderr.write(`Wakeword unavailable: ${err.message}\n`);
			const shouldSwitch = await shouldSwitchToStdinAfterWakewordFailure();
			if (shouldSwitch) {
				try {
					await wakewordSource.stop();
				} catch {
					// Ignore cleanup failure and proceed with stdin fallback.
				}
					return {
						triggerMode: "stdin",
						createSource: createTriggerSource,
						recordingMode,
						recordEnvOverrides,
					};
				}
		}
		try {
			await wakewordSource.stop();
		} catch {
			// Ignore cleanup failure on startup path.
		}
		throw err;
	}
}

function createPrestartedSource(source: TriggerSource): TriggerSource {
	let stopped = false;

	return {
		start() {
			// Source was started during startup resolution.
		},
		nextTrigger() {
			return source.nextTrigger();
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await source.stop();
		},
	};
}

function resolveSessionSettings(
	triggerMode: TriggerMode,
	recordingMode: RecordingMode,
	env: NodeJS.ProcessEnv,
): SessionSettingsSnapshot {
	return {
		provider: env.HERZEN_RESPONSE_PROVIDER?.trim() || "ollama",
		model: env.HERZEN_OLLAMA_MODEL?.trim() || "unconfigured",
		temperature: resolveNumber(env.HERZEN_RESPONSE_TEMPERATURE, DEFAULT_RESPONSE_TEMPERATURE),
		responseTimeoutMs: resolvePositiveInteger(env.HERZEN_RESPONSE_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS),
		triggerMode,
		recordingMode,
		sttLanguageMode: env.HERZEN_STT_LANGUAGE?.trim() || "auto",
	};
}

async function main(): Promise<void> {
	let startupConfig: StartupTriggerRuntimeConfig;
	try {
		startupConfig = await resolveStartupTriggerRuntimeConfig();
	} catch (err) {
		runtimeLogger.error("Failed to resolve startup trigger mode:", err);
		await flushAndExit(1);
		return;
	}

	const runtimeEnv = { ...process.env, ...startupConfig.recordEnvOverrides };
	dialogJournal = createDialogJournal({
		conversationsDir,
		enabled: runtimeEnv.HERZEN_LOG_DIALOG,
		markdownEnabled: runtimeEnv.HERZEN_LOG_DIALOG_MARKDOWN,
		sessionId: runtimeSessionId,
	});
	await dialogJournal.recordSessionStarted(
		resolveSessionSettings(startupConfig.triggerMode, startupConfig.recordingMode, runtimeEnv),
	);

	runtime = createRuntime({
		resolveTriggerMode: () => startupConfig.triggerMode,
		createTriggerSource: startupConfig.createSource,
		isTriggerError,
		onTrigger: createHandleTrigger(startupConfig.recordingMode, startupConfig.recordEnvOverrides, dialogJournal),
		logger: runtimeLogger,
		exit: flushAndExit,
	});

	runtimeLogger.log(`Recording mode: ${startupConfig.recordingMode}`);
	if (startupConfig.recordingMode === "adaptive" && startupConfig.recordEnvOverrides.HERZEN_RECORD_MAX_SECONDS) {
		runtimeLogger.log(
			`Adaptive max length: ${startupConfig.recordEnvOverrides.HERZEN_RECORD_MAX_SECONDS}s`,
		);
	}
	await runtime.run();
}

process.on("SIGINT", () => {
	coreLogger.info("core.shutdown_requested", { message: "\nShutting down…", signal: "SIGINT" });
	if (runtime) {
		void runtime.shutdown(0);
		return;
	}
	void flushAndExit(0);
});

process.on("SIGTERM", () => {
	coreLogger.info("core.shutdown_requested", { message: "\nShutting down…", signal: "SIGTERM" });
	if (runtime) {
		void runtime.shutdown(0);
		return;
	}
	void flushAndExit(0);
});

void main();

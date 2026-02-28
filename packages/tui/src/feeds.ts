import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
	createJsonlStreamReader,
	findLatestSessionId,
	readCurrentSessionId,
	readJsonlTail,
	type JsonlStreamReader,
} from "@herzen/core/conversation/stream";

export type FeedIngressSource = "voice" | "tui" | "automation";

export interface SessionFeedEntry {
	turn?: number;
	role: "user" | "assistant" | "system";
	text: string;
	ts?: string;
	ingressSource?: FeedIngressSource;
}

export interface ActionFeedEntry {
	turn?: number;
	phase?: string;
	ok?: boolean;
	code?: string;
	message?: string;
	ts?: string;
	ingressId?: string;
	ingressSource?: "tui" | "automation";
}

export interface PerfPhaseSummary {
	phase: string;
	count: number;
	avgDurationMs: number;
}

export interface LastTurnTiming {
	turn: number;
	sttMs?: number;
	llmMs?: number;
	ttsMs?: number;
	endToEndMs?: number;
	actionPath?: string;
	language?: string;
}

export interface PerfSummarySnapshot {
	totalEvents: number;
	phases: PerfPhaseSummary[];
	lastTurn?: LastTurnTiming;
}

export interface CoreStatusSnapshot {
	schemaVersion: "core.status.v1";
	sessionId: string;
	profile: "voice" | "text" | "hybrid";
	coreState: "starting" | "ready" | "degraded" | "stopping";
	lastHeartbeatTs: string;
	triggerState: "disabled" | "ready" | "error";
	wakewordState: "disabled" | "ready" | "error";
	sttState: "disabled" | "ready" | "error";
	ttsState: "disabled" | "ready" | "error";
	lastError?: {
		code: string;
		message: string;
		ts: string;
	};
}

export interface CoreRuntimeStatus {
	online: boolean;
	status: CoreStatusSnapshot | null;
}

export interface FeedReaders {
	pollSessionFeed: () => Promise<SessionFeedEntry[]>;
	getActiveSessionId: () => string;
	pollActionFeed: () => Promise<ActionFeedEntry[]>;
	pollPerfSummary: () => Promise<PerfSummarySnapshot>;
	pollCoreStatus: () => Promise<CoreRuntimeStatus>;
}

interface FeedLimits {
	sessionLimit: number;
	actionLimit: number;
	perfLimit: number;
}

const DEFAULT_LIMITS: FeedLimits = {
	sessionLimit: 80,
	actionLimit: 120,
	perfLimit: 500,
};
const CORE_STATUS_STALE_MS = 4_000;

export function createFeedReaders(dataRoot: string, limits: Partial<FeedLimits> = {}): FeedReaders {
	const resolvedLimits: FeedLimits = {
		...DEFAULT_LIMITS,
		...limits,
	};
	const conversationsDir = join(dataRoot, "conversations");
	const controlDir = join(dataRoot, "control");
	const logsDir = join(dataRoot, "logs");

	const actionFile = join(controlDir, "execution.jsonl");
	const coreStatusFile = join(controlDir, "core_status.json");
	const perfFile = join(logsDir, "perf.jsonl");
	const benchmarkFile = join(logsDir, "turn_benchmark.jsonl");

	const actionReader = createJsonlStreamReader(actionFile, { fromNow: true });
	const perfReader = createJsonlStreamReader(perfFile, { fromNow: true });
	const benchmarkReader = createJsonlStreamReader(benchmarkFile, { fromNow: true });

	let activeSessionId = "";
	let sessionReader: JsonlStreamReader | null = null;
	let sessionBootstrapped = false;
	let actionBootstrapped = false;
	let perfBootstrapped = false;
	let latestCoreStatus: CoreStatusSnapshot | null = null;

	const sessionEntries: SessionFeedEntry[] = [];
	const actionEntries: ActionFeedEntry[] = [];
	const perfRecords: Array<Record<string, unknown>> = [];
	let lastTurn: LastTurnTiming | undefined;

	const pollSessionFeed = async (): Promise<SessionFeedEntry[]> => {
		const currentSessionId = await readCurrentSessionId(conversationsDir);
		const desiredSessionId = currentSessionId ?? activeSessionId ?? (await findLatestSessionId(conversationsDir));
		if (!desiredSessionId) {
			activeSessionId = "";
			sessionReader = null;
			sessionBootstrapped = false;
			sessionEntries.length = 0;
			return [];
		}

		if (desiredSessionId !== activeSessionId) {
			activeSessionId = desiredSessionId;
			sessionReader = createJsonlStreamReader(join(conversationsDir, `${activeSessionId}.jsonl`), {
				fromNow: true,
			});
			sessionBootstrapped = false;
			sessionEntries.length = 0;
		}

		if (!sessionReader) return [];
		const sessionFile = join(conversationsDir, `${activeSessionId}.jsonl`);
		if (!sessionBootstrapped) {
			const bootstrapRecords = await readJsonlTail(sessionFile, resolvedLimits.sessionLimit);
			for (const record of bootstrapRecords) {
				const entry = toSessionEntry(record);
				if (!entry) continue;
				sessionEntries.push(entry);
			}
			trimToLimit(sessionEntries, resolvedLimits.sessionLimit);
			sessionBootstrapped = true;
		}

		const records = await sessionReader.poll();
		for (const record of records) {
			const entry = toSessionEntry(record);
			if (!entry) continue;
			sessionEntries.push(entry);
		}
		trimToLimit(sessionEntries, resolvedLimits.sessionLimit);
		return [...sessionEntries];
	};

	const pollActionFeed = async (): Promise<ActionFeedEntry[]> => {
		if (!actionBootstrapped) {
			const bootstrapRecords = await readJsonlTail(actionFile, resolvedLimits.actionLimit);
			for (const record of bootstrapRecords) {
				const entry = toActionEntry(record);
				if (!entry) continue;
				actionEntries.push(entry);
			}
			trimToLimit(actionEntries, resolvedLimits.actionLimit);
			actionBootstrapped = true;
		}

		const records = await actionReader.poll();
		for (const record of records) {
			const entry = toActionEntry(record);
			if (!entry) continue;
			actionEntries.push(entry);
		}
		trimToLimit(actionEntries, resolvedLimits.actionLimit);
		return [...actionEntries];
	};

	const pollPerfSummary = async (): Promise<PerfSummarySnapshot> => {
		if (!perfBootstrapped) {
			const perfBootstrap = await readJsonlTail(perfFile, resolvedLimits.perfLimit);
			for (const record of perfBootstrap) {
				if (!isRecord(record)) continue;
				perfRecords.push(record);
			}
			trimToLimit(perfRecords, resolvedLimits.perfLimit);

			const benchmarkBootstrap = await readJsonlTail(benchmarkFile, 50);
			for (const record of benchmarkBootstrap) {
				const timing = toLastTurnTiming(record);
				if (!timing) continue;
				lastTurn = timing;
			}
			perfBootstrapped = true;
		}

		const perfRecordsDelta = await perfReader.poll();
		for (const record of perfRecordsDelta) {
			if (!isRecord(record)) continue;
			perfRecords.push(record);
		}
		trimToLimit(perfRecords, resolvedLimits.perfLimit);

		const benchmarkRecordsDelta = await benchmarkReader.poll();
		for (const record of benchmarkRecordsDelta) {
			const timing = toLastTurnTiming(record);
			if (!timing) continue;
			lastTurn = timing;
		}

		return {
			totalEvents: perfRecords.length,
			phases: summarizePerfPhases(perfRecords),
			lastTurn,
		};
	};

	const pollCoreStatus = async (): Promise<CoreRuntimeStatus> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(coreStatusFile, "utf8"));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				latestCoreStatus = null;
				return { online: false, status: null };
			}
			return { online: false, status: latestCoreStatus };
		}
		const status = toCoreStatus(parsed);
		if (!status) return { online: false, status: latestCoreStatus };
		latestCoreStatus = status;
		const lastBeatMs = Date.parse(status.lastHeartbeatTs);
		const online = Number.isFinite(lastBeatMs) && Date.now() - lastBeatMs <= CORE_STATUS_STALE_MS;
		return {
			online,
			status,
		};
	};

	return {
		pollSessionFeed,
		getActiveSessionId: () => activeSessionId,
		pollActionFeed,
		pollPerfSummary,
		pollCoreStatus,
	};
}

function toSessionEntry(record: unknown): SessionFeedEntry | null {
	if (!isRecord(record)) return null;
	const ingressSource = asIngressSource(record.ingressSource);
	if (record.type === "user_utterance") {
		return {
			turn: asNumber(record.turn),
			role: "user",
			text: asString(record.text),
			ts: asString(record.ts),
			ingressSource,
		};
	}
	if (record.type === "assistant_utterance") {
		return {
			turn: asNumber(record.turn),
			role: "assistant",
			text: asString(record.text),
			ts: asString(record.ts),
			ingressSource,
		};
	}
	if (record.type === "error") {
		return {
			turn: asNumber(record.turn),
			role: "system",
			text: `[error] ${asString(record.message)}`,
			ts: asString(record.ts),
		};
	}
	return null;
}

function toActionEntry(record: unknown): ActionFeedEntry | null {
	if (!isRecord(record)) return null;
	const details = asRecord(record.details);
	return {
		turn: asNumber(record.turn),
		phase: asString(record.phase),
		ok: asBoolean(record.ok),
		code: asString(record.code),
		message: asString(record.message),
		ts: asString(record.ts),
		ingressId: asOptionalString(details?.ingressId),
		ingressSource: asIngressCommandSource(details?.source),
	};
}

function toLastTurnTiming(record: unknown): LastTurnTiming | null {
	if (!isRecord(record)) return null;
	if (asString(record.schemaVersion) !== "turn_benchmark.v1") return null;
	const turn = asNumber(record.turn);
	if (typeof turn !== "number") return null;
	return {
		turn,
		sttMs: asNumber(record.stt_ms),
		llmMs: asNumber(record.llm_ms),
		ttsMs: asNumber(record.tts_ms),
		endToEndMs: asNumber(record.end_to_end_ms),
		actionPath: asString(record.actionPath),
		language: asString(record.language),
	};
}

function summarizePerfPhases(records: Array<Record<string, unknown>>): PerfPhaseSummary[] {
	const byPhase = new Map<string, { count: number; durationTotalMs: number }>();
	for (const record of records) {
		const phase = asString(record.phase);
		if (!phase) continue;
		const current = byPhase.get(phase) ?? { count: 0, durationTotalMs: 0 };
		current.count += 1;
		current.durationTotalMs += asNumber(record.durationMs) ?? 0;
		byPhase.set(phase, current);
	}

	const phases: PerfPhaseSummary[] = [];
	for (const [phase, summary] of byPhase.entries()) {
		phases.push({
			phase,
			count: summary.count,
			avgDurationMs:
				summary.count > 0 ? Math.round((summary.durationTotalMs / summary.count) * 10) / 10 : 0,
		});
	}
	phases.sort((left, right) => right.count - left.count || left.phase.localeCompare(right.phase));
	return phases;
}

function trimToLimit<T>(items: T[], limit: number): void {
	if (items.length <= limit) return;
	items.splice(0, items.length - limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value) || Array.isArray(value)) return null;
	return value;
}

function toCoreStatus(value: unknown): CoreStatusSnapshot | null {
	const record = asRecord(value);
	if (!record) return null;
	if (asString(record.schemaVersion) !== "core.status.v1") return null;
	const sessionId = asString(record.sessionId);
	const profile = asString(record.profile);
	const coreState = asString(record.coreState);
	const lastHeartbeatTs = asString(record.lastHeartbeatTs);
	const triggerState = asString(record.triggerState);
	const wakewordState = asString(record.wakewordState);
	const sttState = asString(record.sttState);
	const ttsState = asString(record.ttsState);
	if (!sessionId || !lastHeartbeatTs) return null;
	if (profile !== "voice" && profile !== "text" && profile !== "hybrid") return null;
	if (coreState !== "starting" && coreState !== "ready" && coreState !== "degraded" && coreState !== "stopping") {
		return null;
	}
	if (triggerState !== "disabled" && triggerState !== "ready" && triggerState !== "error") return null;
	if (wakewordState !== "disabled" && wakewordState !== "ready" && wakewordState !== "error") return null;
	if (sttState !== "disabled" && sttState !== "ready" && sttState !== "error") return null;
	if (ttsState !== "disabled" && ttsState !== "ready" && ttsState !== "error") return null;
	const lastErrorRecord = asRecord(record.lastError);
	const lastError =
		lastErrorRecord ?
			{
				code: asString(lastErrorRecord.code),
				message: asString(lastErrorRecord.message),
				ts: asString(lastErrorRecord.ts),
			}
		: undefined;
	return {
		schemaVersion: "core.status.v1",
		sessionId,
		profile: profile as CoreStatusSnapshot["profile"],
		coreState: coreState as CoreStatusSnapshot["coreState"],
		lastHeartbeatTs,
		triggerState: triggerState as CoreStatusSnapshot["triggerState"],
		wakewordState: wakewordState as CoreStatusSnapshot["wakewordState"],
		sttState: sttState as CoreStatusSnapshot["sttState"],
		ttsState: ttsState as CoreStatusSnapshot["ttsState"],
		lastError:
			lastError && lastError.code && lastError.message && lastError.ts ? lastError : undefined,
	};
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asIngressSource(value: unknown): FeedIngressSource | undefined {
	if (value === "voice" || value === "tui" || value === "automation") return value;
	return undefined;
}

function asIngressCommandSource(value: unknown): "tui" | "automation" | undefined {
	if (value === "tui" || value === "automation") return value;
	return undefined;
}

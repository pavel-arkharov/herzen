import { cpus, loadavg } from "node:os";

const PERF_SCHEMA_VERSION = "perf.v1";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export type PerfPhase =
	| "turn"
	| "record"
	| "stt"
	| "llm"
	| "tts"
	| "playback"
	| "followup"
	| "runtime";

export type PerfStatus = "started" | "ok" | "error" | "skipped";
export type PerfMode = "trigger" | "followup" | "runtime";

interface PerfEventBase {
	schemaVersion: string;
	type: "phase" | "process_sample";
	ts: string;
	sessionId: string;
	turn?: number;
	mode?: PerfMode;
}

export interface PerfPhaseEvent extends PerfEventBase {
	type: "phase";
	phase: PerfPhase;
	status: PerfStatus;
	durationMs?: number;
	fields?: Record<string, unknown>;
}

export interface ProcessSample {
	rssBytes: number;
	heapTotalBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
	processCpuPercent: number;
	processCpuPercentOfSystem: number;
	load1: number;
	load5: number;
	load15: number;
	uptimeSec: number;
	cpuCount: number;
}

export interface PerfProcessSampleEvent extends PerfEventBase {
	type: "process_sample";
	phase: "runtime";
	status: "ok";
	fields: ProcessSample;
}

export type PerfEvent = PerfPhaseEvent | PerfProcessSampleEvent;

export interface PerfJournalWriter {
	appendJsonl: (streamName: string, entry: unknown) => Promise<void>;
}

export interface CreatePerfJournalConfig {
	writer: PerfJournalWriter;
	sessionId: string;
	enabled?: string | boolean | undefined;
	nowIso?: (() => string) | undefined;
	consoleTarget?: Pick<Console, "warn"> | undefined;
}

export interface PerfJournal {
	readonly enabled: boolean;
	recordPhase: (event: {
		phase: PerfPhase;
		status: PerfStatus;
		turn?: number;
		mode?: PerfMode;
		durationMs?: number;
		fields?: Record<string, unknown>;
	}) => Promise<void>;
	recordProcessSample: (sample: ProcessSample) => Promise<void>;
}

export interface CreateProcessSampleCollectorOptions {
	nowHrTimeNs?: () => bigint;
	cpuUsage?: () => NodeJS.CpuUsage;
	memoryUsage?: () => NodeJS.MemoryUsage;
	uptimeSeconds?: () => number;
	loadAverage?: () => [number, number, number];
	cpuCount?: () => number;
}

function resolveFlag(raw: string | boolean | undefined, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return fallback;
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return fallback;
}

function warn(consoleTarget: Pick<Console, "warn">, message: string, err?: unknown): void {
	try {
		consoleTarget.warn(message, err);
	} catch {
		// Ignore secondary warning failures.
	}
}

function clampNonNegative(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value < 0 ? 0 : value;
}

export function createProcessSampleCollector(options: CreateProcessSampleCollectorOptions = {}): () => ProcessSample {
	const nowHrTimeNs = options.nowHrTimeNs ?? (() => process.hrtime.bigint());
	const readCpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
	const readMemoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
	const readUptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
	const readLoadAverage = options.loadAverage ?? (() => loadavg() as [number, number, number]);
	const readCpuCount = options.cpuCount ?? (() => cpus().length || 1);

	let previousHrNs = nowHrTimeNs();
	let previousCpu = readCpuUsage();

	return () => {
		const currentHrNs = nowHrTimeNs();
		const currentCpu = readCpuUsage();
		const elapsedMicros = Number(currentHrNs - previousHrNs) / 1_000;
		const cpuDeltaMicros =
			(currentCpu.user - previousCpu.user) +
			(currentCpu.system - previousCpu.system);

		previousHrNs = currentHrNs;
		previousCpu = currentCpu;

		const processCpuPercent =
			elapsedMicros > 0 ? clampNonNegative((cpuDeltaMicros / elapsedMicros) * 100) : 0;
		const cpuCount = Math.max(1, readCpuCount());
		const processCpuPercentOfSystem = clampNonNegative(processCpuPercent / cpuCount);
		const memory = readMemoryUsage();
		const [load1, load5, load15] = readLoadAverage();

		return {
			rssBytes: memory.rss,
			heapTotalBytes: memory.heapTotal,
			heapUsedBytes: memory.heapUsed,
			externalBytes: memory.external,
			arrayBuffersBytes: memory.arrayBuffers,
			processCpuPercent,
			processCpuPercentOfSystem,
			load1,
			load5,
			load15,
			uptimeSec: readUptimeSeconds(),
			cpuCount,
		};
	};
}

export function createPerfJournal(config: CreatePerfJournalConfig): PerfJournal {
	const enabled = resolveFlag(config.enabled, true);
	const nowIso = config.nowIso ?? (() => new Date().toISOString());
	const consoleTarget = config.consoleTarget ?? console;

	const append = async (entry: PerfEvent): Promise<void> => {
		if (!enabled) return;
		try {
			await config.writer.appendJsonl("perf", entry);
		} catch (err) {
			warn(consoleTarget, "Perf journal write failed.", err);
		}
	};

	const recordPhase = async (event: {
		phase: PerfPhase;
		status: PerfStatus;
		turn?: number;
		mode?: PerfMode;
		durationMs?: number;
		fields?: Record<string, unknown>;
	}): Promise<void> => {
		await append({
			schemaVersion: PERF_SCHEMA_VERSION,
			type: "phase",
			ts: nowIso(),
			sessionId: config.sessionId,
			phase: event.phase,
			status: event.status,
			durationMs: event.durationMs,
			turn: event.turn,
			mode: event.mode,
			fields: event.fields,
		});
	};

	const recordProcessSample = async (sample: ProcessSample): Promise<void> => {
		await append({
			schemaVersion: PERF_SCHEMA_VERSION,
			type: "process_sample",
			ts: nowIso(),
			sessionId: config.sessionId,
			phase: "runtime",
			status: "ok",
			mode: "runtime",
			fields: sample,
		});
	};

	return {
		enabled,
		recordPhase,
		recordProcessSample,
	};
}

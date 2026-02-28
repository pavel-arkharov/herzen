import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createObservabilityEventEnvelope } from "./envelope.js";
import type { SttLogEntry } from "../app/turn.js";
import { resolveSettings } from "../settings/registry.js";

export type LogLevel = "info" | "warn" | "error";
export type LogComponent = "core" | "stt" | "trigger" | "tts";

export interface StructuredLogEntry {
	ts: string;
	level: LogLevel;
	component: LogComponent;
	event: string;
	sessionId?: string;
	message?: string;
	fields?: Record<string, unknown>;
}

export interface LoggerConfig {
	logsDir: string;
	component: LogComponent;
	level?: string | undefined;
	logTranscript?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	sessionId?: string | undefined;
	nowIso?: () => string;
	consoleTarget?: Pick<Console, "log" | "warn" | "error">;
}

export interface Logger {
	level: LogLevel;
	transcriptEnabled: boolean;
	info: (event: string, fields?: Record<string, unknown>) => void;
	warn: (event: string, fields?: Record<string, unknown>) => void;
	error: (event: string, fields?: Record<string, unknown>) => void;
	appendJsonl: (streamName: string, entry: unknown, eventMeta?: LoggerEventMeta) => Promise<void>;
	drain: () => Promise<void>;
}

export interface LoggerEventMeta {
	turn?: number;
	source?: string;
	category?: string;
	severity?: LogLevel;
}

const levelPriority: Record<LogLevel, number> = {
	info: 10,
	warn: 20,
	error: 30,
};

function resolveLogLevel(rawLevel: string | undefined, fallback: LogLevel): LogLevel {
	const normalized = rawLevel?.trim().toLowerCase();
	if (normalized === "warn") return "warn";
	if (normalized === "error") return "error";
	if (normalized === "info") return "info";
	return fallback;
}

function resolveFlag(rawValue: string | undefined, fallback: boolean): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return fallback;
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function asFieldsPayload(input: Record<string, unknown> | undefined): {
	message: string | undefined;
	fields: Record<string, unknown> | undefined;
} {
	if (!input) return { message: undefined, fields: undefined };
	const fields = { ...input };
	const message = typeof fields.message === "string" ? fields.message : undefined;
	delete fields.message;
	return {
		message,
		fields: Object.keys(fields).length > 0 ? fields : undefined,
	};
}

function emitConsole(
	consoleTarget: Pick<Console, "log" | "warn" | "error">,
	level: LogLevel,
	component: LogComponent,
	event: string,
	message: string | undefined,
	fields: Record<string, unknown> | undefined,
): void {
	const method = level === "info" ? "log" : level;
	const fallback = `[${component}] ${event}`;
	const line = message ?? fallback;
	if (fields) {
		consoleTarget[method](line, fields);
		return;
	}
	consoleTarget[method](line);
}

function emitFallbackWarning(
	consoleTarget: Pick<Console, "log" | "warn" | "error">,
	label: string,
	err: unknown,
): void {
	try {
		consoleTarget.warn(`${label}`, err);
	} catch {
		// Ignore secondary failures from warning fallback paths.
	}
}

function sanitizeStreamName(streamName: string): string | null {
	const trimmed = streamName.trim();
	if (!trimmed) return null;
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) return null;
	return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function toStructuredSttTurnEntry(
	entry: SttLogEntry,
	options: {
		transcriptEnabled: boolean;
		audioInputEnabled?: boolean;
		sessionId?: string;
	},
): StructuredLogEntry {
	const isErrorLevel = Boolean(entry.errorCode) || entry.llmOutcome === "error";
	const fields: Record<string, unknown> = {
		latencyMs: entry.latencyMs,
		durationMs: entry.durationMs,
		languageMode: entry.languageMode,
	};

	if (options.audioInputEnabled && entry.audioFile) fields.audioFile = entry.audioFile;
	if (entry.language) fields.detectedLanguage = entry.language;
	if (entry.errorCode) fields.errorCode = entry.errorCode;
	if (entry.llmProvider) fields.llmProvider = entry.llmProvider;
	if (entry.llmModel) fields.llmModel = entry.llmModel;
	if (typeof entry.llmLatencyMs === "number") fields.llmLatencyMs = entry.llmLatencyMs;
	if (entry.llmOutcome) fields.llmOutcome = entry.llmOutcome;
	if (entry.llmErrorCode) fields.llmErrorCode = entry.llmErrorCode;
	if (options.transcriptEnabled && entry.transcript) fields.transcript = entry.transcript;

	return {
		ts: entry.timestamp,
		level: isErrorLevel ? "error" : "info",
		component: "stt",
		event: "stt.turn",
		sessionId: options.sessionId,
		fields,
	};
}

export function createLogger(config: LoggerConfig): Logger {
	const settings = resolveSettings(config.env ?? process.env).logging;
	const level = resolveLogLevel(config.level, settings.level);
	const transcriptEnabled = resolveFlag(config.logTranscript, settings.transcriptEnabled);
	const nowIso = config.nowIso ?? (() => new Date().toISOString());
	const consoleTarget = config.consoleTarget ?? console;
	const pendingWrites = new Set<Promise<void>>();

	try {
		mkdirSync(config.logsDir, { recursive: true });
	} catch (err) {
		emitFallbackWarning(consoleTarget, "Failed to create logs directory.", err);
	}

	const appendJsonl = async (
		streamName: string,
		entry: unknown,
		eventMeta: LoggerEventMeta = {},
	): Promise<void> => {
		const writeTask = (async () => {
			try {
				const stream = sanitizeStreamName(streamName);
				if (!stream) {
					emitFallbackWarning(consoleTarget, `Refused to write invalid stream "${streamName}".`, undefined);
					return;
				}

				const file = join(config.logsDir, `${stream}.jsonl`);
				await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");

				// Mirror all non-canonical streams into a canonical envelope stream during migration.
				if (stream !== "events") {
					const entryRecord = asRecord(entry);
					const eventTs = typeof entryRecord?.ts === "string" ? entryRecord.ts : nowIso();
					const envelope = createObservabilityEventEnvelope({
						ts: eventTs,
						sessionId: config.sessionId,
						turn: eventMeta.turn,
						source: eventMeta.source ?? config.component,
						category: eventMeta.category ?? `stream.${stream}`,
						severity: eventMeta.severity ?? "info",
						payload: entryRecord ?? { value: entry },
					});
					const envelopeFile = join(config.logsDir, "events.jsonl");
					await appendFile(envelopeFile, `${JSON.stringify(envelope)}\n`, "utf8");
				}
			} catch (err) {
				emitFallbackWarning(consoleTarget, `Failed to append log stream "${streamName}".`, err);
			}
		})();

		pendingWrites.add(writeTask);
		void writeTask.finally(() => {
			pendingWrites.delete(writeTask);
		});
		await writeTask;
	};

	const emit = (entryLevel: LogLevel, event: string, rawFields?: Record<string, unknown>): void => {
		if (levelPriority[entryLevel] < levelPriority[level]) return;
		try {
			const { message, fields } = asFieldsPayload(rawFields);
			emitConsole(consoleTarget, entryLevel, config.component, event, message, fields);
			const entry: StructuredLogEntry = {
				ts: nowIso(),
				level: entryLevel,
				component: config.component,
				event,
				sessionId: config.sessionId,
				message,
				fields,
			};
			void appendJsonl("runtime", entry, {
				source: config.component,
				category: event,
				severity: entryLevel,
			});
		} catch (err) {
			emitFallbackWarning(consoleTarget, "Failed to emit runtime log entry.", err);
		}
	};

	const drain = async (): Promise<void> => {
		while (true) {
			const snapshot = [...pendingWrites];
			if (snapshot.length === 0) {
				// Yield once so microtasks that schedule follow-up writes are observed.
				await Promise.resolve();
				if (pendingWrites.size === 0) return;
				continue;
			}

			await Promise.allSettled(snapshot);
		}
	};

	return {
		level,
		transcriptEnabled,
		info: (event, fields) => {
			emit("info", event, fields);
		},
		warn: (event, fields) => {
			emit("warn", event, fields);
		},
		error: (event, fields) => {
			emit("error", event, fields);
		},
		appendJsonl,
		drain,
	};
}

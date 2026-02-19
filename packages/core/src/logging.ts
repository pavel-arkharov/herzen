import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { SttLogEntry } from "./turn.js";

export type LogLevel = "info" | "warn" | "error";
export type LogComponent = "core" | "stt" | "trigger" | "tts";

export interface StructuredLogEntry {
	ts: string;
	level: LogLevel;
	component: LogComponent;
	event: string;
	message?: string;
	fields?: Record<string, unknown>;
}

export interface LoggerConfig {
	logsDir: string;
	component: LogComponent;
	level?: string | undefined;
	logTranscript?: string | undefined;
	nowIso?: () => string;
	consoleTarget?: Pick<Console, "log" | "warn" | "error">;
}

export interface Logger {
	level: LogLevel;
	transcriptEnabled: boolean;
	info: (event: string, fields?: Record<string, unknown>) => void;
	warn: (event: string, fields?: Record<string, unknown>) => void;
	error: (event: string, fields?: Record<string, unknown>) => void;
	appendJsonl: (streamName: string, entry: unknown) => Promise<void>;
	drain: () => Promise<void>;
}

const levelPriority: Record<LogLevel, number> = {
	info: 10,
	warn: 20,
	error: 30,
};

function resolveLogLevel(rawLevel: string | undefined): LogLevel {
	const normalized = rawLevel?.trim().toLowerCase();
	if (normalized === "warn") return "warn";
	if (normalized === "error") return "error";
	return "info";
}

function isFlagEnabled(rawValue: string | undefined): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return false;
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

export function toStructuredSttTurnEntry(
	entry: SttLogEntry,
	options: { transcriptEnabled: boolean },
): StructuredLogEntry {
	const isErrorLevel = Boolean(entry.errorCode) || entry.llmOutcome === "error";
	const fields: Record<string, unknown> = {
		audioFile: entry.audioFile,
		latencyMs: entry.latencyMs,
		durationMs: entry.durationMs,
		languageMode: entry.languageMode,
	};

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
		fields,
	};
}

export function createLogger(config: LoggerConfig): Logger {
	const level = resolveLogLevel(config.level ?? process.env.HERZEN_LOG_LEVEL);
	const transcriptEnabled = isFlagEnabled(config.logTranscript ?? process.env.HERZEN_LOG_TRANSCRIPT);
	const nowIso = config.nowIso ?? (() => new Date().toISOString());
	const consoleTarget = config.consoleTarget ?? console;
	const pendingWrites = new Set<Promise<void>>();

	try {
		mkdirSync(config.logsDir, { recursive: true });
	} catch (err) {
		emitFallbackWarning(consoleTarget, "Failed to create logs directory.", err);
	}

	const appendJsonl = async (streamName: string, entry: unknown): Promise<void> => {
		const writeTask = (async () => {
			try {
				const stream = sanitizeStreamName(streamName);
				if (!stream) {
					emitFallbackWarning(consoleTarget, `Refused to write invalid stream "${streamName}".`, undefined);
					return;
				}

				const file = join(config.logsDir, `${stream}.jsonl`);
				await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
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
				message,
				fields,
			};
			void appendJsonl("runtime", entry);
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

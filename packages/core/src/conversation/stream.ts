import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataRoot } from "../app/paths.js";

export interface SessionWatchOptions {
	help: boolean;
	sessionId?: string;
	pollMs: number;
	fromNow: boolean;
	showBenchmarks: boolean;
}

export interface SessionWatchRenderState {
	lastTurn?: number;
}

export interface CreateJsonlStreamReaderOptions {
	fromNow?: boolean;
}

export interface JsonlStreamReader {
	poll: () => Promise<unknown[]>;
}

export async function readJsonlTail(filePath: string, limit: number): Promise<unknown[]> {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, "r");
		const fileStat = await handle.stat();
		if (fileStat.size <= 0) return [];

		const chunkSize = 8 * 1024;
		let position = fileStat.size;
		let carry = "";
		const tailLines: string[] = [];

		while (position > 0 && tailLines.length < limit) {
			const readSize = Math.min(chunkSize, position);
			position -= readSize;
			const chunk = Buffer.alloc(readSize);
			const { bytesRead } = await handle.read(chunk, 0, readSize, position);
			const combined = `${chunk.toString("utf8", 0, bytesRead)}${carry}`;
			const segments = combined.split("\n");
			carry = segments.shift() ?? "";
			for (let i = segments.length - 1; i >= 0 && tailLines.length < limit; i -= 1) {
				const line = segments[i]?.trim();
				if (line) tailLines.push(line);
			}
		}

		if (tailLines.length < limit) {
			const line = carry.trim();
			if (line) tailLines.push(line);
		}

		tailLines.reverse();
		const records: unknown[] = [];
		for (const line of tailLines) {
			try {
				records.push(JSON.parse(line));
			} catch {
				continue;
			}
		}
		return records;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	} finally {
		await handle?.close();
	}
}

export type DialogTailOptions = SessionWatchOptions;
export type DialogTailRenderState = SessionWatchRenderState;

export function parseSessionWatchArgs(argv: string[]): SessionWatchOptions {
	const options: SessionWatchOptions = {
		help: false,
		pollMs: 700,
		fromNow: false,
		showBenchmarks: true,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--from-now") {
			options.fromNow = true;
			continue;
		}
		if (arg === "--no-benchmark") {
			options.showBenchmarks = false;
			continue;
		}
		if (arg === "--session") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("Missing value for --session.");
			}
			const normalized = sanitizeSessionId(value);
			if (!normalized) {
				throw new Error(`Invalid --session value "${value}".`);
			}
			options.sessionId = normalized;
			i += 1;
			continue;
		}
		if (arg === "--poll-ms") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("Missing value for --poll-ms.");
			}
			const parsed = Number.parseInt(value, 10);
			if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60_000) {
				throw new Error(`Invalid --poll-ms "${value}". Expected integer in [100, 60000].`);
			}
			options.pollMs = parsed;
			i += 1;
			continue;
		}

		throw new Error(`Unknown argument "${arg}".`);
	}

	return options;
}

export function parseDialogTailArgs(argv: string[]): DialogTailOptions {
	return parseSessionWatchArgs(argv);
}

export function sanitizeSessionId(rawValue: string | undefined): string | null {
	const value = rawValue?.trim();
	if (!value) return null;
	if (value.includes("/") || value.includes("\\")) return null;
	if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
	return value;
}

export async function readCurrentSessionId(conversationsDir: string): Promise<string | null> {
	try {
		const raw = await readFile(join(conversationsDir, "current_session"), "utf8");
		return sanitizeSessionId(raw);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function findLatestSessionId(conversationsDir: string): Promise<string | null> {
	let latestSessionId: string | null = null;
	let latestTimestamp = -1;

	const entries = await readdir(conversationsDir, { withFileTypes: true }).catch(
		(err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return [];
			throw err;
		},
	);

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".jsonl")) continue;
		const sessionId = sanitizeSessionId(entry.name.slice(0, -".jsonl".length));
		if (!sessionId) continue;

		const file = join(conversationsDir, entry.name);
		const fileStat = await stat(file).catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return null;
			throw err;
		});
		if (!fileStat) continue;
		if (fileStat.mtimeMs > latestTimestamp) {
			latestTimestamp = fileStat.mtimeMs;
			latestSessionId = sessionId;
		}
	}

	return latestSessionId;
}

export function createJsonlStreamReader(
	filePath: string,
	options: CreateJsonlStreamReaderOptions = {},
): JsonlStreamReader {
	let initialized = false;
	let consumedBytes = 0;
	let buffer = "";

	return {
		poll: async () => {
			if (!initialized) {
				initialized = true;
				if (options.fromNow) {
					consumedBytes = await resolveInitialOffset(filePath);
				}
			}

			const deltaResult = await readUtf8Delta(filePath, consumedBytes);
			if (!deltaResult) {
				consumedBytes = 0;
				buffer = "";
				return [];
			}
			if (deltaResult.truncated) {
				buffer = "";
			}
			consumedBytes = deltaResult.nextOffset;
			if (!deltaResult.delta) return [];

			const combined = `${buffer}${deltaResult.delta}`;
			const { records, remainder } = parseJsonlLines(combined);
			buffer = remainder;
			return records;
		},
	};
}

export function formatConversationEvent(
	event: Record<string, unknown>,
	renderState: SessionWatchRenderState,
): string[] {
	const lines: string[] = [];
	const type = asOptionalString(event.type) ?? "unknown";
	if (shouldSuppressActionEvent(type, event)) return lines;

	const turn = asOptionalNumber(event.turn);
	if (typeof turn === "number" && renderState.lastTurn !== turn) {
		renderState.lastTurn = turn;
		lines.push("");
		lines.push(`Turn ${turn}`);
	}

	switch (type) {
		case "session_started": {
			lines.push("");
			lines.push(`Session started: ${asOptionalString(event.sessionId) ?? "unknown"}`);
			const settings = asRecord(event.settings);
			if (settings) {
				lines.push(
					`Settings: provider=${asOptionalString(settings.provider) ?? "unknown"}, model=${asOptionalString(settings.model) ?? "unknown"}, trigger=${asOptionalString(settings.triggerMode) ?? "unknown"}, recording=${asOptionalString(settings.recordingMode) ?? "unknown"}`,
				);
			}
			return lines;
		}
		case "user_utterance":
			lines.push(`User: ${asOptionalString(event.text) ?? ""}`);
			return lines;
		case "assistant_utterance":
			lines.push(`Herzen: ${asOptionalString(event.text) ?? ""}`);
			return lines;
		case "action_call":
		case "action_result": {
			const integration = asOptionalString(event.integration) ?? "unknown";
			const operation = asOptionalString(event.operation) ?? "unknown";
			lines.push(`${type === "action_call" ? "Action call" : "Action result"}: ${integration}.${operation}`);
			if (integration === "core.followup") {
				return lines;
			}
			const payload = type === "action_call" ? asRecord(event.args) : asRecord(event.result);
			if (payload) {
				lines.push(...prettyJsonBlock(payload));
			}
			return lines;
		}
		case "error": {
			const stage = asOptionalString(event.stage) ?? "unknown";
			const code = asOptionalString(event.code);
			const codeSuffix = code ? `:${code}` : "";
			lines.push(`Error [${stage}${codeSuffix}]: ${asOptionalString(event.message) ?? "unknown"}`);
			return lines;
		}
		case "session_ended": {
			lines.push("");
			lines.push(`Session ended (${asOptionalString(event.reason) ?? "unknown"})`);
			return lines;
		}
		default:
			lines.push(`Event ${type}: ${JSON.stringify(event)}`);
			return lines;
	}
}

export function formatDialogEvent(
	event: Record<string, unknown>,
	renderState: DialogTailRenderState,
): string[] {
	return formatConversationEvent(event, renderState);
}

export function formatTurnBenchmarkEvent(
	event: Record<string, unknown>,
	renderState: SessionWatchRenderState,
): string[] {
	const lines: string[] = [];
	const schemaVersion = asOptionalString(event.schemaVersion);
	if (schemaVersion !== "turn_benchmark.v1") return lines;

	const turn = asOptionalNumber(event.turn);
	if (typeof turn === "number" && renderState.lastTurn !== turn) {
		renderState.lastTurn = turn;
		lines.push("");
		lines.push(`Turn ${turn}`);
	}

	const triggerMode = asOptionalString(event.triggerMode) ?? "unknown";
	const actionPath = asOptionalString(event.actionPath) ?? "unknown";
	const language = asOptionalString(event.language) ?? "unknown";
	const sttMs = formatMetric(event.stt_ms);
	const haMs = formatMetric(event.ha_intent_ms);
	const llmMs = formatMetric(event.llm_ms);
	const ttsMs = formatMetric(event.tts_ms);
	const endToEndMs = formatMetric(event.end_to_end_ms);
	const speakTailMs = formatMetric(event.speak_tail_ms);
	const errorCode = asOptionalString(event.errorCode);
	const llmOutcome = asOptionalString(event.llmOutcome);
	const outcomeSuffix = llmOutcome ? ` llm=${llmOutcome}` : "";
	const errorSuffix = errorCode ? ` error=${errorCode}` : "";

	lines.push(
		`Bench: trigger=${triggerMode} path=${actionPath} lang=${language} stt=${sttMs} ha=${haMs} llm=${llmMs} tts=${ttsMs} e2e=${endToEndMs} tail=${speakTailMs}${outcomeSuffix}${errorSuffix}`,
	);
	return lines;
}

export { resolveDataRoot };

async function resolveInitialOffset(filePath: string): Promise<number> {
	try {
		const fileStat = await stat(filePath);
		return fileStat.size;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw err;
	}
}

async function readUtf8Delta(
	filePath: string,
	offset: number,
): Promise<{ delta: string; nextOffset: number; truncated: boolean } | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, "r");
		const fileStat = await handle.stat();
		const normalizedOffset = offset > fileStat.size ? 0 : Math.max(0, offset);
		const truncated = normalizedOffset !== offset;
		const bytesToRead = fileStat.size - normalizedOffset;
		if (bytesToRead <= 0) {
			return {
				delta: "",
				nextOffset: normalizedOffset,
				truncated,
			};
		}
		const chunk = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(chunk, 0, bytesToRead, normalizedOffset);
		return {
			delta: chunk.toString("utf8", 0, bytesRead),
			nextOffset: normalizedOffset + bytesRead,
			truncated,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	} finally {
		await handle?.close();
	}
}

function shouldSuppressActionEvent(type: string, event: Record<string, unknown>): boolean {
	if (type !== "action_call") return false;
	const integration = asOptionalString(event.integration);
	if (integration !== "core.followup") return false;
	const operation = asOptionalString(event.operation);
	return operation === "window_opened" || operation === "turn_started";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatMetric(value: unknown): string {
	const metric = asOptionalNumber(value);
	if (typeof metric !== "number") return "-";
	return `${Math.round(metric)}ms`;
}

function prettyJsonBlock(value: unknown): string[] {
	const body = JSON.stringify(value, null, 2);
	if (!body) return [];
	return ["```json", body, "```"];
}

function parseJsonlLines(input: string): { records: unknown[]; remainder: string } {
	const records: unknown[] = [];
	let cursor = 0;
	while (cursor < input.length) {
		const lineBreak = input.indexOf("\n", cursor);
		if (lineBreak === -1) break;
		const line = input.slice(cursor, lineBreak).trim();
		if (line) {
			try {
				records.push(JSON.parse(line));
			} catch {
				// Ignore malformed JSON lines and continue streaming.
			}
		}
		cursor = lineBreak + 1;
	}
	return {
		records,
		remainder: input.slice(cursor),
	};
}

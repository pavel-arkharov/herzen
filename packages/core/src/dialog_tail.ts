import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

export interface DialogTailOptions {
	help: boolean;
	sessionId?: string;
	pollMs: number;
	fromNow: boolean;
}

export interface DialogTailRenderState {
	lastTurn?: number;
}

export function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

export function parseDialogTailArgs(argv: string[]): DialogTailOptions {
	const options: DialogTailOptions = {
		help: false,
		pollMs: 700,
		fromNow: false,
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

	const entries = await readdir(conversationsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
		if (err.code === "ENOENT") return [];
		throw err;
	});

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

export function formatDialogEvent(event: Record<string, unknown>, renderState: DialogTailRenderState): string[] {
	const lines: string[] = [];
	const turn = asOptionalNumber(event.turn);
	if (typeof turn === "number" && renderState.lastTurn !== turn) {
		renderState.lastTurn = turn;
		lines.push("");
		lines.push(`Turn ${turn}`);
	}

	const type = asOptionalString(event.type) ?? "unknown";
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

function prettyJsonBlock(value: unknown): string[] {
	const body = JSON.stringify(value, null, 2);
	if (!body) return [];
	return ["```json", body, "```"];
}

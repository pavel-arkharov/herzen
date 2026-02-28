import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionSummaryArtifactV1 {
	schemaVersion: "context.summary.v1";
	sessionId: string;
	updatedAt: string;
	summary: string;
	sourceEventIds: string[];
}

export interface SessionSummaryStore {
	read: () => SessionSummaryArtifactV1 | null;
	write: (artifact: SessionSummaryArtifactV1) => Promise<void>;
	filePath: string;
}

export interface CreateSessionSummaryStoreOptions {
	conversationsDir: string;
	sessionId: string;
	consoleTarget?: Pick<Console, "warn">;
}

export function createSessionSummaryStore(
	options: CreateSessionSummaryStoreOptions,
): SessionSummaryStore {
	const consoleTarget = options.consoleTarget ?? console;
	const filePath = join(options.conversationsDir, `${options.sessionId}.summary.json`);

	try {
		mkdirSync(options.conversationsDir, { recursive: true });
	} catch (err) {
		warn(consoleTarget, "Failed to initialize session summary directory.", err);
	}

	const read = (): SessionSummaryArtifactV1 | null => {
		let raw: string;
		try {
			raw = readFileSync(filePath, "utf8");
		} catch {
			return null;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}

		if (!isSessionSummary(parsed)) return null;
		if (parsed.sessionId !== options.sessionId) return null;
		return parsed;
	};

	const write = async (artifact: SessionSummaryArtifactV1): Promise<void> => {
		try {
			await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		} catch (err) {
			warn(consoleTarget, "Failed to write session summary artifact.", err);
		}
	};

	return {
		read,
		write,
		filePath,
	};
}

function isSessionSummary(value: unknown): value is SessionSummaryArtifactV1 {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.schemaVersion !== "context.summary.v1") return false;
	if (typeof candidate.sessionId !== "string") return false;
	if (typeof candidate.updatedAt !== "string") return false;
	if (typeof candidate.summary !== "string") return false;
	if (!Array.isArray(candidate.sourceEventIds)) return false;
	return candidate.sourceEventIds.every((item) => typeof item === "string");
}

function warn(consoleTarget: Pick<Console, "warn">, message: string, err: unknown): void {
	try {
		consoleTarget.warn(message, err);
	} catch {
		// Ignore warning failures.
	}
}

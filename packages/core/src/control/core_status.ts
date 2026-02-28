import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeProfile } from "./contracts.js";

export type CoreState = "starting" | "ready" | "degraded" | "stopping";
export type TriggerState = "disabled" | "ready" | "error";
export type ServiceState = "disabled" | "ready" | "error";

export interface CoreStatusV1 {
	schemaVersion: "core.status.v1";
	sessionId: string;
	profile: RuntimeProfile;
	coreState: CoreState;
	lastHeartbeatTs: string;
	triggerState: TriggerState;
	wakewordState: TriggerState;
	sttState: ServiceState;
	ttsState: ServiceState;
	lastError?: {
		code: string;
		message: string;
		ts: string;
	};
}

export interface CoreStatusWriter {
	snapshot: () => CoreStatusV1;
	update: (patch: Partial<Omit<CoreStatusV1, "schemaVersion" | "sessionId">>) => Promise<void>;
	beat: () => Promise<void>;
}

export interface CreateCoreStatusWriterConfig {
	controlDir: string;
	sessionId: string;
	initialProfile: RuntimeProfile;
}

const STATUS_FILE = "core_status.json";

export function coreStatusFilePath(controlDir: string): string {
	return join(controlDir, STATUS_FILE);
}

export function createCoreStatusWriter(config: CreateCoreStatusWriterConfig): CoreStatusWriter {
	mkdirSync(config.controlDir, { recursive: true });
	const filePath = coreStatusFilePath(config.controlDir);
	const tempPath = `${filePath}.tmp`;
	let writeQueue = Promise.resolve();
	let status: CoreStatusV1 = {
		schemaVersion: "core.status.v1",
		sessionId: config.sessionId,
		profile: config.initialProfile,
		coreState: "starting",
		lastHeartbeatTs: new Date().toISOString(),
		triggerState: "disabled",
		wakewordState: "disabled",
		sttState: "ready",
		ttsState: "ready",
	};

	const flush = async (): Promise<void> => {
		const payload = `${JSON.stringify(status, null, 2)}\n`;
		await writeFile(tempPath, payload, "utf8");
		await rename(tempPath, filePath);
	};

	const update = async (
		patch: Partial<Omit<CoreStatusV1, "schemaVersion" | "sessionId">>,
	): Promise<void> => {
		status = {
			...status,
			...patch,
			lastHeartbeatTs: new Date().toISOString(),
		};
		writeQueue = writeQueue.then(() => flush()).catch(() => undefined);
		await writeQueue;
	};

	return {
		snapshot: () => status,
		update,
		beat: async () => {
			await update({});
		},
	};
}

export async function readCoreStatusSnapshot(controlDir: string): Promise<CoreStatusV1 | null> {
	const filePath = coreStatusFilePath(controlDir);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(filePath, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed.schemaVersion !== "core.status.v1") return null;
	if (typeof parsed.sessionId !== "string") return null;
	if (parsed.profile !== "voice" && parsed.profile !== "text" && parsed.profile !== "hybrid") return null;
	if (
		parsed.coreState !== "starting" &&
		parsed.coreState !== "ready" &&
		parsed.coreState !== "degraded" &&
		parsed.coreState !== "stopping"
	) {
		return null;
	}
	const status: CoreStatusV1 = {
		schemaVersion: "core.status.v1",
		sessionId: parsed.sessionId,
		profile: parsed.profile,
		coreState: parsed.coreState,
		lastHeartbeatTs: typeof parsed.lastHeartbeatTs === "string" ? parsed.lastHeartbeatTs : "",
		triggerState:
			parsed.triggerState === "disabled" || parsed.triggerState === "ready" || parsed.triggerState === "error" ?
				parsed.triggerState
			:	"disabled",
		wakewordState:
			parsed.wakewordState === "disabled" || parsed.wakewordState === "ready" || parsed.wakewordState === "error" ?
				parsed.wakewordState
			:	"disabled",
		sttState:
			parsed.sttState === "disabled" || parsed.sttState === "ready" || parsed.sttState === "error" ?
				parsed.sttState
			:	"disabled",
		ttsState:
			parsed.ttsState === "disabled" || parsed.ttsState === "ready" || parsed.ttsState === "error" ?
				parsed.ttsState
			:	"disabled",
	};
	if (!status.lastHeartbeatTs) return null;
	if (isRecord(parsed.lastError)) {
		const code = typeof parsed.lastError.code === "string" ? parsed.lastError.code : "";
		const message = typeof parsed.lastError.message === "string" ? parsed.lastError.message : "";
		const ts = typeof parsed.lastError.ts === "string" ? parsed.lastError.ts : "";
		if (code && message && ts) {
			status.lastError = { code, message, ts };
		}
	}
	return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

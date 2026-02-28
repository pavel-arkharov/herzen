import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ControlIngressEnvelopeV1, RuntimeProfile } from "./contracts.js";

export interface BaseIngressCommand {
	ingressId: string;
	sessionId: string;
	source: "tui" | "automation";
	traceId?: string;
	ts: string;
}

export interface ChatIngressCommand extends BaseIngressCommand {
	command: "chat.send";
	text: string;
}

export interface RuntimeSetProfileIngressCommand extends BaseIngressCommand {
	command: "runtime.set_profile";
	profile: RuntimeProfile;
}

export interface VoiceTriggerOnceIngressCommand extends BaseIngressCommand {
	command: "voice.trigger_once";
}

export interface WakewordSetEnabledIngressCommand extends BaseIngressCommand {
	command: "wakeword.set_enabled";
	enabled: boolean;
}

export interface RuntimeGetStatusIngressCommand extends BaseIngressCommand {
	command: "runtime.get_status";
	includeDiagnostics?: boolean;
}

export type ControlIngressCommand =
	| ChatIngressCommand
	| RuntimeSetProfileIngressCommand
	| VoiceTriggerOnceIngressCommand
	| WakewordSetEnabledIngressCommand
	| RuntimeGetStatusIngressCommand;

export interface ControlIngressReader {
	poll: () => Promise<ControlIngressCommand[]>;
}

export function controlIngressFilePath(controlDir: string): string {
	return join(controlDir, "ingress.jsonl");
}

export function createControlIngressReader(controlDir: string): ControlIngressReader {
	const filePath = controlIngressFilePath(controlDir);
	let consumedBytes = 0;
	let buffer = "";

	return {
		poll: async () => {
			const chunk = await readDelta(filePath, consumedBytes);
			if (!chunk) return [];
			consumedBytes = chunk.nextOffset;
			if (!chunk.data) return [];

			const records: ControlIngressCommand[] = [];
			const combined = `${buffer}${chunk.data}`;
			const lines = combined.split("\n");
			buffer = lines.pop() ?? "";

			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line) continue;
				const parsed = parseControlIngress(line);
				if (!parsed) continue;
				records.push(parsed);
			}
			return records;
		},
	};
}

async function readDelta(
	filePath: string,
	offset: number,
): Promise<{ data: string; nextOffset: number } | null> {
	let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fileHandle = await open(filePath, "r");
		const stats = await fileHandle.stat();
		let normalizedOffset = offset;
		if (stats.size < normalizedOffset) normalizedOffset = 0;
		const bytesToRead = stats.size - normalizedOffset;
		if (bytesToRead <= 0) return { data: "", nextOffset: stats.size };

		const chunk = Buffer.alloc(bytesToRead);
		const { bytesRead } = await fileHandle.read(chunk, 0, bytesToRead, normalizedOffset);
		return {
			data: chunk.toString("utf8", 0, bytesRead),
			nextOffset: normalizedOffset + bytesRead,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	} finally {
		await fileHandle?.close();
	}
}

function parseControlIngress(rawLine: string): ControlIngressCommand | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const envelope = parsed as Partial<ControlIngressEnvelopeV1>;
	if (envelope.schemaVersion !== "control.ingress.v1") return null;
	if (!isRecord(envelope.payload)) return null;

	const ingressId = asString(envelope.ingressId).trim();
	const sessionId = asString(envelope.sessionId).trim();
	const source = asIngressSource(envelope.source);
	const command = asString(envelope.command).trim();
	const ts = asString(envelope.ts).trim();
	const traceId = asString(envelope.traceId).trim() || undefined;
	if (!ingressId || !sessionId || !source || !command || !ts) return null;

	const payload = envelope.payload as Record<string, unknown>;
	if (asString(payload.sessionId).trim() && asString(payload.sessionId).trim() !== sessionId) return null;
	if (asString(payload.source).trim() && asString(payload.source).trim() !== source) return null;

	const base: BaseIngressCommand = {
		ingressId,
		sessionId,
		source,
		traceId,
		ts,
	};

	switch (command) {
		case "chat.send": {
			const text = asString(payload.text).trim();
			if (!text) return null;
			return {
				...base,
				command,
				text,
			};
		}
		case "runtime.set_profile": {
			const profile = asRuntimeProfile(payload.profile);
			if (!profile) return null;
			return {
				...base,
				command,
				profile,
			};
		}
		case "voice.trigger_once":
			return {
				...base,
				command,
			};
		case "wakeword.set_enabled": {
			const enabled = asBoolean(payload.enabled);
			if (enabled === undefined) return null;
			return {
				...base,
				command,
				enabled,
			};
		}
		case "runtime.get_status": {
			const includeDiagnostics = asBoolean(payload.includeDiagnostics);
			return {
				...base,
				command,
				includeDiagnostics,
			};
		}
		default:
			return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asIngressSource(value: unknown): "tui" | "automation" | null {
	return value === "tui" || value === "automation" ? value : null;
}

function asRuntimeProfile(value: unknown): RuntimeProfile | null {
	return value === "voice" || value === "text" || value === "hybrid" ? value : null;
}

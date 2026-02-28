import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "dialog.v1";

export type DialogEventType =
	| "session_started"
	| "user_utterance"
	| "assistant_utterance"
	| "action_call"
	| "action_result"
	| "error"
	| "session_ended";

type IngressSource = "voice" | "tui" | "automation";

export interface SessionSettingsSnapshot {
	provider: string;
	model: string;
	temperature: number;
	responseTimeoutMs: number;
	runtimeProfile?: "voice" | "text" | "hybrid";
	triggerMode: string;
	recordingMode: string;
	sttLanguageMode: string;
}

interface BaseDialogEvent {
	schemaVersion: string;
	sessionId: string;
	seq: number;
	ts: string;
	type: DialogEventType;
}

export interface SessionStartedEvent extends BaseDialogEvent {
	type: "session_started";
	settings: SessionSettingsSnapshot;
}

export interface UserUtteranceEvent extends BaseDialogEvent {
	type: "user_utterance";
	turn: number;
	text: string;
	ingressSource?: IngressSource;
	detectedLanguage?: string;
	requestedLanguage?: "auto" | "en" | "ru";
}

export interface AssistantUtteranceEvent extends BaseDialogEvent {
	type: "assistant_utterance";
	turn: number;
	text: string;
	ingressSource?: IngressSource;
	language?: "en" | "ru";
	provider?: string;
	model?: string;
}

export interface ActionCallEvent extends BaseDialogEvent {
	type: "action_call";
	turn: number;
	integration: string;
	operation: string;
	args: Record<string, unknown>;
}

export interface ActionResultEvent extends BaseDialogEvent {
	type: "action_result";
	turn: number;
	integration: string;
	operation: string;
	result: Record<string, unknown>;
}

export interface ErrorEvent extends BaseDialogEvent {
	type: "error";
	turn?: number;
	stage: string;
	code?: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface SessionEndedEvent extends BaseDialogEvent {
	type: "session_ended";
	reason?: string;
}

export type DialogEvent =
	| SessionStartedEvent
	| UserUtteranceEvent
	| AssistantUtteranceEvent
	| ActionCallEvent
	| ActionResultEvent
	| ErrorEvent
	| SessionEndedEvent;

export interface CreateDialogJournalConfig {
	conversationsDir: string;
	enabled?: string | boolean | undefined;
	markdownEnabled?: string | boolean | undefined;
	sessionId?: string | undefined;
	nowIso?: (() => string) | undefined;
	consoleTarget?: Pick<Console, "warn"> | undefined;
}

export interface DialogJournal {
	readonly enabled: boolean;
	readonly markdownEnabled: boolean;
	readonly sessionId: string;
	recordSessionStarted: (settings: SessionSettingsSnapshot) => Promise<void>;
	recordUserUtterance: (event: {
		turn: number;
		text: string;
		ingressSource?: IngressSource;
		detectedLanguage?: string;
		requestedLanguage?: "auto" | "en" | "ru";
	}) => Promise<void>;
	recordAssistantUtterance: (event: {
		turn: number;
		text: string;
		ingressSource?: IngressSource;
		language?: "en" | "ru";
		provider?: string;
		model?: string;
	}) => Promise<void>;
	recordActionCall: (event: {
		turn: number;
		integration: string;
		operation: string;
		args: Record<string, unknown>;
	}) => Promise<void>;
	recordActionResult: (event: {
		turn: number;
		integration: string;
		operation: string;
		result: Record<string, unknown>;
	}) => Promise<void>;
	recordError: (event: {
		turn?: number;
		stage: string;
		code?: string;
		message: string;
		details?: Record<string, unknown>;
	}) => Promise<void>;
	recordSessionEnded: (event?: { reason?: string }) => Promise<void>;
	drain: () => Promise<void>;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

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

function toMarkdownText(text: string): string {
	return text.replace(/\r?\n/g, " ").trim();
}

function markdownSessionHeader(sessionId: string, startedAtIso: string, settings: SessionSettingsSnapshot): string {
	return [
		`# Herzen Session ${sessionId}`,
		`Started: ${startedAtIso}`,
		"",
		"## Session Settings",
		`- provider: ${settings.provider}`,
		`- model: ${settings.model}`,
		`- temperature: ${settings.temperature}`,
		`- responseTimeoutMs: ${settings.responseTimeoutMs}`,
		`- runtimeProfile: ${settings.runtimeProfile ?? "voice"}`,
		`- triggerMode: ${settings.triggerMode}`,
		`- recordingMode: ${settings.recordingMode}`,
		`- sttLanguageMode: ${settings.sttLanguageMode}`,
		"",
		"## Dialogue",
		"",
	].join("\n");
}

function markdownActionBlock(event: {
	type: "action_call" | "action_result";
	integration: string;
	operation: string;
	args?: Record<string, unknown>;
	result?: Record<string, unknown>;
}): string {
	return [`\`\`\`json`, `${JSON.stringify(event)}`, `\`\`\``, ""].join("\n");
}

export function createDialogJournal(config: CreateDialogJournalConfig): DialogJournal {
	const enabled = resolveFlag(config.enabled, true);
	const markdownEnabled = enabled && resolveFlag(config.markdownEnabled, true);
	const sessionId = config.sessionId?.trim() || randomUUID();
	const nowIso = config.nowIso ?? (() => new Date().toISOString());
	const consoleTarget = config.consoleTarget ?? console;
	const jsonlFile = join(config.conversationsDir, `${sessionId}.jsonl`);
	const markdownFile = join(config.conversationsDir, `${sessionId}.md`);
	const currentSessionFile = join(config.conversationsDir, "current_session");
	const pendingWrites = new Set<Promise<void>>();

	let seq = 0;
	let sessionStartedWritten = false;
	let sessionEndedWritten = false;
	let writeQueue = Promise.resolve();
	let currentMarkdownTurn: number | null = null;

	try {
		mkdirSync(config.conversationsDir, { recursive: true });
	} catch (err) {
		warn(consoleTarget, "Failed to create conversation journal directory.", err);
	}

	if (enabled) {
		const pointerTask = writeFile(currentSessionFile, `${sessionId}\n`, "utf8").catch((err) => {
			warn(consoleTarget, "Failed to update current conversation session pointer.", err);
		});
		pendingWrites.add(pointerTask);
		void pointerTask.finally(() => {
			pendingWrites.delete(pointerTask);
		});
	}

	const enqueueWrites = async (
		event: DialogEvent,
		markdownChunk?: string,
	): Promise<void> => {
		if (!enabled) return;

		const writeTask = writeQueue
			.then(async () => {
				try {
					const line = `${JSON.stringify(event)}\n`;
					await appendFile(jsonlFile, line, "utf8");
					if (markdownEnabled && markdownChunk) {
						await appendFile(markdownFile, markdownChunk, "utf8");
					}
				} catch (err) {
					warn(consoleTarget, "Conversation journal write failed.", err);
				}
			})
			.catch((err) => {
				warn(consoleTarget, "Conversation journal queue failed.", err);
			});

		writeQueue = writeTask;
		pendingWrites.add(writeTask);
		void writeTask.finally(() => {
			pendingWrites.delete(writeTask);
		});
		await writeTask;
	};

	const appendEvent = async (
		type: DialogEventType,
		payload: Omit<DialogEvent, keyof BaseDialogEvent | "type">,
		markdownChunk?: string,
	): Promise<void> => {
		if (!enabled) return;
		const event = {
			schemaVersion: SCHEMA_VERSION,
			sessionId,
			seq: ++seq,
			ts: nowIso(),
			type,
			...payload,
		} as DialogEvent;

		await enqueueWrites(event, markdownChunk);
	};

	const markdownTurnHeader = (turn: number): string => {
		if (!markdownEnabled) return "";
		if (currentMarkdownTurn === turn) return "";
		currentMarkdownTurn = turn;
		return `### Turn ${turn}\n`;
	};

	const recordSessionStarted = async (settings: SessionSettingsSnapshot): Promise<void> => {
		if (!enabled || sessionStartedWritten) return;
		sessionStartedWritten = true;
		const startedAt = nowIso();
		await appendEvent(
			"session_started",
			{ settings },
			markdownEnabled ? markdownSessionHeader(sessionId, startedAt, settings) : undefined,
		);
	};

	const recordUserUtterance = async (event: {
		turn: number;
		text: string;
		ingressSource?: IngressSource;
		detectedLanguage?: string;
		requestedLanguage?: "auto" | "en" | "ru";
	}): Promise<void> => {
		await appendEvent("user_utterance", event, `${markdownTurnHeader(event.turn)}User: ${toMarkdownText(event.text)}\n`);
	};

	const recordAssistantUtterance = async (event: {
		turn: number;
		text: string;
		ingressSource?: IngressSource;
		language?: "en" | "ru";
		provider?: string;
		model?: string;
	}): Promise<void> => {
		await appendEvent(
			"assistant_utterance",
			event,
			`${markdownTurnHeader(event.turn)}Herzen: ${toMarkdownText(event.text)}\n`,
		);
	};

	const recordActionCall = async (event: {
		turn: number;
		integration: string;
		operation: string;
		args: Record<string, unknown>;
	}): Promise<void> => {
		await appendEvent(
			"action_call",
			event,
			`${markdownTurnHeader(event.turn)}${markdownActionBlock({
				type: "action_call",
				integration: event.integration,
				operation: event.operation,
				args: event.args,
			})}`,
		);
	};

	const recordActionResult = async (event: {
		turn: number;
		integration: string;
		operation: string;
		result: Record<string, unknown>;
	}): Promise<void> => {
		await appendEvent(
			"action_result",
			event,
			`${markdownTurnHeader(event.turn)}${markdownActionBlock({
				type: "action_result",
				integration: event.integration,
				operation: event.operation,
				result: event.result,
			})}`,
		);
	};

	const recordError = async (event: {
		turn?: number;
		stage: string;
		code?: string;
		message: string;
		details?: Record<string, unknown>;
	}): Promise<void> => {
		let markdownChunk = "";
		if (markdownEnabled) {
			const prefix = typeof event.turn === "number" ? markdownTurnHeader(event.turn) : "";
			const label = event.code ? `Error (${event.stage}:${event.code})` : `Error (${event.stage})`;
			markdownChunk = `${prefix}${label}: ${toMarkdownText(event.message)}\n`;
		}
		await appendEvent("error", event, markdownChunk);
	};

	const recordSessionEnded = async (event: { reason?: string } = {}): Promise<void> => {
		if (!enabled || sessionEndedWritten) return;
		sessionEndedWritten = true;
		await appendEvent(
			"session_ended",
			{
				reason: event.reason,
			},
			markdownEnabled ? `\n## Session Ended\n- ts: ${nowIso()}\n- reason: ${event.reason ?? "unknown"}\n` : undefined,
		);
	};

	const drain = async (): Promise<void> => {
		while (true) {
			const snapshot = [...pendingWrites];
			if (snapshot.length === 0) {
				await Promise.resolve();
				if (pendingWrites.size === 0) return;
				continue;
			}
			await Promise.allSettled(snapshot);
		}
	};

	return {
		enabled,
		markdownEnabled,
		sessionId,
		recordSessionStarted,
		recordUserUtterance,
		recordAssistantUtterance,
		recordActionCall,
		recordActionResult,
		recordError,
		recordSessionEnded,
		drain,
	};
}

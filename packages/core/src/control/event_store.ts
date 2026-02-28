import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandEnvelopeV1, ExecutionEventV1, IntentRecordV1 } from "./contracts.js";

export interface CreateControlEventStoreConfig {
	controlDir: string;
	sessionId: string;
	consoleTarget?: Pick<Console, "warn">;
}

export interface ControlEventStore {
	appendIntent: (record: IntentRecordV1) => Promise<void>;
	appendCommand: (record: CommandEnvelopeV1) => Promise<void>;
	appendExecution: (record: ExecutionEventV1) => Promise<void>;
	drain: () => Promise<void>;
}

export function createControlEventStore(config: CreateControlEventStoreConfig): ControlEventStore {
	const consoleTarget = config.consoleTarget ?? console;
	const sessionsDir = join(config.controlDir, "sessions");
	const intentFile = join(config.controlDir, "intent.jsonl");
	const commandFile = join(config.controlDir, "commands.jsonl");
	const executionFile = join(config.controlDir, "execution.jsonl");
	const sessionFile = join(sessionsDir, `${config.sessionId}.jsonl`);
	const pendingWrites = new Set<Promise<void>>();
	let writeQueue = Promise.resolve();

	try {
		mkdirSync(config.controlDir, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
	} catch (err) {
		warn(consoleTarget, "Failed to initialize control store directories.", err);
	}

	const appendToStreams = async (
		stream: "intent" | "commands" | "execution",
		record: IntentRecordV1 | CommandEnvelopeV1 | ExecutionEventV1,
	): Promise<void> => {
		const task = writeQueue
			.then(async () => {
				try {
					const line = `${JSON.stringify(record)}\n`;
					if (stream === "intent") await appendFile(intentFile, line, "utf8");
					if (stream === "commands") await appendFile(commandFile, line, "utf8");
					if (stream === "execution") await appendFile(executionFile, line, "utf8");
					await appendFile(
						sessionFile,
						`${JSON.stringify({
							stream,
							record,
						})}\n`,
						"utf8",
					);
				} catch (err) {
					warn(consoleTarget, `Failed to write control stream "${stream}".`, err);
				}
			})
			.catch((err) => {
				warn(consoleTarget, "Control stream queue failed.", err);
			});
		writeQueue = task;
		pendingWrites.add(task);
		void task.finally(() => {
			pendingWrites.delete(task);
		});
		await task;
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
		appendIntent: async (record) => appendToStreams("intent", record),
		appendCommand: async (record) => appendToStreams("commands", record),
		appendExecution: async (record) => appendToStreams("execution", record),
		drain,
	};
}

function warn(consoleTarget: Pick<Console, "warn">, message: string, err: unknown): void {
	try {
		consoleTarget.warn(message, err);
	} catch {
		// Ignore warning fallback failures.
	}
}

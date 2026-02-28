import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createControlEventStore } from "../src/control/event_store.js";

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
	const raw = await readFile(filePath, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("control event store", () => {
	it("writes intent, command, and execution streams plus session merged stream", async () => {
		const controlDir = await mkdtemp(join(tmpdir(), "herzen-control-"));
		const store = createControlEventStore({
			controlDir,
			sessionId: "session-1",
		});

		try {
			await store.appendIntent({
				schemaVersion: "intent.v1",
				intentId: "intent-1",
				sessionId: "session-1",
				turn: 1,
				source: "deterministic",
				route: "respond",
				actionable: false,
				confidence: 0.8,
				ts: "2026-02-27T00:00:00.000Z",
			});
			await store.appendCommand({
				schemaVersion: "command.v1",
				commandId: "command-1",
				sessionId: "session-1",
				turn: 1,
				laneKey: "session:session-1:trigger",
				name: "homeassistant.light.turn_on",
				args: { entity_id: "light.kitchen" },
				policyScope: "ha:write",
				idempotencyKey: "idem-1",
				ts: "2026-02-27T00:00:01.000Z",
			});
			await store.appendExecution({
				schemaVersion: "execution.v1",
				eventId: "exec-1",
				sessionId: "session-1",
				turn: 1,
				phase: "route_decided",
				ok: true,
				ts: "2026-02-27T00:00:02.000Z",
			});
			await store.drain();

			const intents = await readJsonl(join(controlDir, "intent.jsonl"));
			const commands = await readJsonl(join(controlDir, "commands.jsonl"));
			const execution = await readJsonl(join(controlDir, "execution.jsonl"));
			const merged = await readJsonl(join(controlDir, "sessions", "session-1.jsonl"));

			expect(intents).toHaveLength(1);
			expect(commands).toHaveLength(1);
			expect(execution).toHaveLength(1);
			expect(merged).toHaveLength(3);
			expect(merged.map((entry) => entry.stream)).toEqual(["intent", "commands", "execution"]);
		} finally {
			await rm(controlDir, { recursive: true, force: true });
		}
	});
});

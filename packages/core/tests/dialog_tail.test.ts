import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	createJsonlStreamReader,
	formatDialogEvent,
	formatTurnBenchmarkEvent,
	parseDialogTailArgs,
	readJsonlTail,
} from "../src/conversation/stream.js";

function createTempRoot(prefix: string): string {
	const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

describe("parseDialogTailArgs", () => {
	it("parses defaults and explicit options", () => {
		expect(parseDialogTailArgs([])).toEqual({
			help: false,
			pollMs: 700,
			fromNow: false,
			showBenchmarks: true,
		});

		expect(
			parseDialogTailArgs(["--session", "abc-123", "--poll-ms", "900", "--from-now", "--no-benchmark"]),
		).toEqual({
			help: false,
			sessionId: "abc-123",
			pollMs: 900,
			fromNow: true,
			showBenchmarks: false,
		});
	});

	it("throws on invalid args", () => {
		expect(() => parseDialogTailArgs(["--session", "../bad"])).toThrow(/Invalid --session/);
		expect(() => parseDialogTailArgs(["--poll-ms", "50"])).toThrow(/Invalid --poll-ms/);
		expect(() => parseDialogTailArgs(["--unknown"])).toThrow(/Unknown argument/);
	});
});

describe("formatDialogEvent", () => {
	it("formats user and assistant utterances with turn headers", () => {
		const state = {};

		const userLines = formatDialogEvent(
			{
				type: "user_utterance",
				turn: 3,
				text: "Turn off kitchen lights.",
			},
			state,
		);
		const assistantLines = formatDialogEvent(
			{
				type: "assistant_utterance",
				turn: 3,
				text: "Done.",
			},
			state,
		);

		expect(userLines).toEqual(["", "Turn 3", "User: Turn off kitchen lights."]);
		expect(assistantLines).toEqual(["Herzen: Done."]);
	});

	it("formats action and error events for human-readable output", () => {
		const state = {};

		const actionLines = formatDialogEvent(
			{
				type: "action_call",
				turn: 2,
				integration: "home_assistant",
				operation: "light.turn_off",
				args: { entity_id: "light.kitchen" },
			},
			state,
		);
		const errorLines = formatDialogEvent(
			{
				type: "error",
				turn: 2,
				stage: "response",
				code: "RUNTIME_UNAVAILABLE",
				message: "Connection refused",
			},
			state,
		);

		expect(actionLines[2]).toBe("Action call: home_assistant.light.turn_off");
		expect(actionLines).toContain("```json");
		expect(errorLines).toEqual(["Error [response:RUNTIME_UNAVAILABLE]: Connection refused"]);
	});

	it("suppresses noisy follow-up action_call events and preserves turn headers", () => {
		const state = {};

		const suppressed = formatDialogEvent(
			{
				type: "action_call",
				turn: 2,
				integration: "core.followup",
				operation: "turn_started",
				args: { index: 1, remainingWindowMs: 7999 },
			},
			state,
		);
		const nextUtterance = formatDialogEvent(
			{
				type: "assistant_utterance",
				turn: 2,
				text: "I am listening.",
			},
			state,
		);

		expect(suppressed).toEqual([]);
		expect(nextUtterance).toEqual(["", "Turn 2", "Herzen: I am listening."]);
	});

	it("formats follow-up action_result without verbose json payload", () => {
		const state = {};

		const lines = formatDialogEvent(
			{
				type: "action_result",
				turn: 3,
				integration: "core.followup",
				operation: "window_closed",
				result: { reason: "window_elapsed", executedTurns: 3 },
			},
			state,
		);

		expect(lines).toEqual(["", "Turn 3", "Action result: core.followup.window_closed"]);
	});
});

describe("formatTurnBenchmarkEvent", () => {
	it("formats concise per-turn benchmark line", () => {
		const state = {};
		const lines = formatTurnBenchmarkEvent(
			{
				schemaVersion: "turn_benchmark.v1",
				turn: 4,
				triggerMode: "wakeword",
				actionPath: "home_assistant",
				language: "ru",
				stt_ms: 220,
				ha_intent_ms: 80,
				llm_ms: 0,
				tts_ms: 310,
				end_to_end_ms: 910,
				speak_tail_ms: 310,
				llmOutcome: "ok",
			},
			state,
		);

		expect(lines).toEqual([
			"",
			"Turn 4",
			"Bench: trigger=wakeword path=home_assistant lang=ru stt=220ms ha=80ms llm=0ms tts=310ms e2e=910ms tail=310ms llm=ok",
		]);
	});

	it("returns empty lines for unrelated events", () => {
		const state = {};
		expect(formatTurnBenchmarkEvent({ schemaVersion: "other" }, state)).toEqual([]);
	});
});

describe("jsonl stream reader", () => {
	it("reads append-only records incrementally", async () => {
		const root = createTempRoot("stream-growth");
		const file = join(root, "events.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "a", value: 1 })}\n`, "utf8");

		const reader = createJsonlStreamReader(file);
		expect(await reader.poll()).toEqual([{ type: "a", value: 1 }]);
		expect(await reader.poll()).toEqual([]);

		appendFileSync(
			file,
			[
				"{bad-json}",
				JSON.stringify({ type: "b", value: 2 }),
				JSON.stringify({ type: "c", value: 3 }),
			].join("\n") + "\n",
			"utf8",
		);
		expect(await reader.poll()).toEqual([
			{ type: "b", value: 2 },
			{ type: "c", value: 3 },
		]);
	});

	it("resets stream state after truncation", async () => {
		const root = createTempRoot("stream-truncate");
		const file = join(root, "events.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "before", value: 1 })}\n`, "utf8");

		const reader = createJsonlStreamReader(file);
		expect(await reader.poll()).toEqual([{ type: "before", value: 1 }]);

		writeFileSync(file, `${JSON.stringify({ type: "after", value: 2 })}\n`, "utf8");
		expect(await reader.poll()).toEqual([{ type: "after", value: 2 }]);
	});

	it("reads only the latest tail records for bootstrap", async () => {
		const root = createTempRoot("stream-tail");
		const file = join(root, "events.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ index: 1 }),
				JSON.stringify({ index: 2 }),
				JSON.stringify({ index: 3 }),
			].join("\n") + "\n",
			"utf8",
		);

		const tail = await readJsonlTail(file, 2);
		expect(tail).toEqual([{ index: 2 }, { index: 3 }]);
	});
});

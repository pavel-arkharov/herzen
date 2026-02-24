import { describe, expect, it } from "vitest";
import { formatDialogEvent, parseDialogTailArgs } from "../src/dialog_tail.js";

describe("parseDialogTailArgs", () => {
	it("parses defaults and explicit options", () => {
		expect(parseDialogTailArgs([])).toEqual({
			help: false,
			pollMs: 700,
			fromNow: false,
		});

		expect(parseDialogTailArgs(["--session", "abc-123", "--poll-ms", "900", "--from-now"])).toEqual({
			help: false,
			sessionId: "abc-123",
			pollMs: 900,
			fromNow: true,
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

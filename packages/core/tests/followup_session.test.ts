import { describe, expect, it, vi } from "vitest";
import { runFollowupSession } from "../src/conversation/followup_session.js";

function makeTurn(turn: number, transcript: string | undefined) {
	return {
		turn,
		hasTranscript: Boolean(transcript),
		transcript,
		detectedLanguage: transcript ? "en" : undefined,
		assistantText: transcript ? "reply" : "",
		assistantLanguage: "en" as const,
		assistantSource: "model" as const,
		llmOutcome: "ok" as const,
	};
}

describe("runFollowupSession", () => {
	it("does not open when follow-up is disabled", async () => {
		const runTurn = vi.fn();

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: false,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: [],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(result).toEqual({
			opened: false,
			executedTurns: 0,
			lastTurn: 1,
		});
		expect(runTurn).not.toHaveBeenCalled();
	});

	it("does not open when initial turn has no transcript", async () => {
		const runTurn = vi.fn();

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, undefined),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: [],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(result).toEqual({
			opened: false,
			executedTurns: 0,
			lastTurn: 1,
		});
		expect(runTurn).not.toHaveBeenCalled();
	});

	it("runs a follow-up turn without a new trigger when enabled", async () => {
		const runTurn = vi.fn(async () => makeTurn(2, "follow-up"));

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 1,
				stopPhrases: [],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(runTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "followup",
				suppressNoSpeechFallback: true,
			}),
		);
		expect(result).toEqual({
			opened: true,
			closeReason: "max_turns",
			executedTurns: 1,
			lastTurn: 2,
		});
	});

	it("closes on no speech in follow-up turn", async () => {
		const runTurn = vi.fn(async () => makeTurn(2, undefined));

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: [],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(result.closeReason).toBe("no_speech");
		expect(result.executedTurns).toBe(1);
	});

	it("closes on timeout before next follow-up turn starts", async () => {
		const runTurn = vi.fn();
		const nowMs = vi
			.fn<() => number>()
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(9_500);

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: [],
			},
			nowMs,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(result).toEqual({
			opened: true,
			closeReason: "timeout",
			executedTurns: 0,
			lastTurn: 1,
		});
		expect(runTurn).not.toHaveBeenCalled();
	});

	it("closes on turn error", async () => {
		const runTurn = vi.fn(async () => {
			throw new Error("mic unavailable");
		});

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: [],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(runTurn).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			opened: true,
			closeReason: "error",
			executedTurns: 0,
			lastTurn: 1,
		});
	});

	it("closes when stop phrase is detected", async () => {
		const runTurn = vi.fn(async () => makeTurn(2, "stop"));

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: ["stop"],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: (text) => text === "stop",
		});

		expect(result.closeReason).toBe("stop_phrase");
		expect(result.executedTurns).toBe(1);
	});

	it("enforces max follow-up turns", async () => {
		const runTurn = vi
			.fn()
			.mockResolvedValueOnce(makeTurn(2, "one"))
			.mockResolvedValueOnce(makeTurn(3, "two"));

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 2,
				stopPhrases: [],
			},
			nowMs: () => 1_000,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(runTurn).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			opened: true,
			closeReason: "max_turns",
			executedTurns: 2,
			lastTurn: 3,
		});
	});

	it("refreshes timeout budget after each successful follow-up turn", async () => {
		const runTurn = vi
			.fn()
			.mockResolvedValueOnce(makeTurn(2, "one"))
			.mockResolvedValueOnce(makeTurn(3, "two"));
		const nowMs = vi
			.fn<() => number>()
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(1_001)
			.mockReturnValueOnce(8_900)
			.mockReturnValueOnce(8_901)
			.mockReturnValueOnce(9_800);

		const result = await runFollowupSession({
			initialTurn: makeTurn(1, "hello"),
			config: {
				enabled: true,
				windowSeconds: 8,
				maxTurns: 2,
				stopPhrases: [],
			},
			nowMs,
			runTurn,
			isStopPhrase: () => false,
		});

		expect(runTurn).toHaveBeenCalledTimes(2);
		expect(runTurn).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				remainingWindowMs: expect.any(Number),
			}),
		);
		const secondRemainingWindowMs = runTurn.mock.calls[1]?.[0]?.remainingWindowMs;
		expect(typeof secondRemainingWindowMs).toBe("number");
		expect(secondRemainingWindowMs).toBeGreaterThan(7_000);
		expect(result.closeReason).toBe("max_turns");
	});
});

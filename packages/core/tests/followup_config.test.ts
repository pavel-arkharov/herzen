import { describe, expect, it, vi } from "vitest";
import {
	isFollowupStopPhrase,
	normalizeFollowupPhrase,
	parseStopPhrases,
	resolveFollowupConfig,
} from "../src/followup_config.js";

describe("resolveFollowupConfig", () => {
	it("uses safe defaults", () => {
		expect(resolveFollowupConfig({})).toEqual({
			enabled: false,
			windowSeconds: 8,
			maxTurns: 3,
			stopPhrases: [],
		});
	});

	it("parses configured values", () => {
		expect(
			resolveFollowupConfig({
				HERZEN_FOLLOWUP_ENABLED: "1",
				HERZEN_FOLLOWUP_WINDOW_SECONDS: "12.5",
				HERZEN_FOLLOWUP_MAX_TURNS: "4",
				HERZEN_FOLLOWUP_STOP_PHRASES: "stop, thanks,  Хватит  ",
			}),
		).toEqual({
			enabled: true,
			windowSeconds: 12.5,
			maxTurns: 4,
			stopPhrases: ["stop", "thanks", "хватит"],
		});
	});

	it("falls back on invalid values and emits warnings", () => {
		const warn = vi.fn();
		const config = resolveFollowupConfig(
			{
				HERZEN_FOLLOWUP_ENABLED: "maybe",
				HERZEN_FOLLOWUP_WINDOW_SECONDS: "-1",
				HERZEN_FOLLOWUP_MAX_TURNS: "1.7",
			},
			{ warn },
		);

		expect(config).toEqual({
			enabled: false,
			windowSeconds: 8,
			maxTurns: 3,
			stopPhrases: [],
		});
		expect(warn).toHaveBeenCalledTimes(3);
	});

	it("rejects partially numeric follow-up window values", () => {
		const warn = vi.fn();
		const config = resolveFollowupConfig(
			{
				HERZEN_FOLLOWUP_WINDOW_SECONDS: "8abc",
			},
			{ warn },
		);

		expect(config.windowSeconds).toBe(8);
		expect(warn).toHaveBeenCalledWith(
			'Invalid HERZEN_FOLLOWUP_WINDOW_SECONDS "8abc". Falling back to 8.',
		);
	});
});

describe("stop phrase normalization", () => {
	it("normalizes and deduplicates configured stop phrases", () => {
		expect(parseStopPhrases(" stop , stop!, thanks , , Хватит ")).toEqual([
			"stop",
			"thanks",
			"хватит",
		]);
	});

	it("matches transcript by exact normalized phrase equality", () => {
		const stopPhrases = ["stop", "хватит"];

		expect(normalizeFollowupPhrase("  ...Stop!?  ")).toBe("stop");
		expect(isFollowupStopPhrase(" stop ", stopPhrases)).toBe(true);
		expect(isFollowupStopPhrase("ХВАТИТ!", stopPhrases)).toBe(true);
		expect(isFollowupStopPhrase("stop now", stopPhrases)).toBe(false);
	});
});

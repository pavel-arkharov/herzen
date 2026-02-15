import { describe, expect, it, vi } from "vitest";
import {
	formatRecordStartLabel,
	resolveRecordPlan,
	SAFE_FALLBACK_RECORD_SECONDS,
} from "../src/recording.js";

function resolvePlan(env: NodeJS.ProcessEnv) {
	const warn = vi.fn();
	const plan = resolveRecordPlan(env, { warn });
	return { plan, warn };
}

describe("resolveRecordPlan", () => {
	it("defaults to fixed mode", () => {
		const { plan, warn } = resolvePlan({});
		expect(plan).toEqual({ mode: "fixed", seconds: 3 });
		expect(warn).not.toHaveBeenCalled();
	});

	it("clamps fixed seconds to upper bound", () => {
		const { plan } = resolvePlan({
			HERZEN_RECORD_SECONDS: "120",
		});
		expect(plan).toEqual({ mode: "fixed", seconds: 30 });
	});

	it("falls back to fixed defaults when adaptive fields are invalid", () => {
		const { plan, warn } = resolvePlan({
			HERZEN_RECORD_MODE: "adaptive",
			HERZEN_RECORD_MAX_SECONDS: "nope",
		});
		expect(plan).toEqual({ mode: "fixed", seconds: 3 });
		expect(warn).toHaveBeenCalledWith(
			"Invalid adaptive recording config (HERZEN_RECORD_MAX_SECONDS). Falling back to fixed 3.0 seconds.",
		);
	});

	it("resolves adaptive plan and applies clamping", () => {
		const { plan, warn } = resolvePlan({
			HERZEN_RECORD_MODE: "adaptive",
			HERZEN_RECORD_MAX_SECONDS: "50",
			HERZEN_RECORD_MIN_SECONDS: "0.1",
			HERZEN_RECORD_SILENCE_SECONDS: "7",
			HERZEN_RECORD_SILENCE_THRESHOLD: "0.01",
			HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS: "0.1",
		});

		expect(plan).toEqual({
			mode: "adaptive",
			maxSeconds: 30,
			minSeconds: 0.2,
			silenceSeconds: 5,
			silenceThresholdPercent: 0.1,
			noSpeechTimeoutSeconds: 0.5,
			fallbackSeconds: SAFE_FALLBACK_RECORD_SECONDS,
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("falls back to fixed when adaptive constraints conflict", () => {
		const { plan, warn } = resolvePlan({
			HERZEN_RECORD_MODE: "adaptive",
			HERZEN_RECORD_MAX_SECONDS: "2",
			HERZEN_RECORD_MIN_SECONDS: "2",
		});
		expect(plan).toEqual({ mode: "fixed", seconds: 3 });
		expect(warn).toHaveBeenCalledWith(
			"Invalid adaptive recording config (HERZEN_RECORD_MIN_SECONDS >= HERZEN_RECORD_MAX_SECONDS). Falling back to fixed 3.0 seconds.",
		);
	});
});

describe("formatRecordStartLabel", () => {
	it("renders fixed mode labels", () => {
		expect(formatRecordStartLabel({ mode: "fixed", seconds: 4.25 })).toBe("Recording 4.3 seconds…");
	});

	it("renders adaptive mode labels", () => {
		expect(
			formatRecordStartLabel({
				mode: "adaptive",
				maxSeconds: 10,
				minSeconds: 1,
				silenceSeconds: 0.8,
				silenceThresholdPercent: 1,
				noSpeechTimeoutSeconds: 2.5,
				fallbackSeconds: 3,
			}),
		).toBe("Recording (adaptive, max 10.0s)…");
	});
});

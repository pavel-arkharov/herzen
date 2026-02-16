import { describe, expect, it, vi } from "vitest";
import {
	formatRecordStartLabel,
	resolveInitialRecordEnvOverridesInteractive,
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

describe("resolveInitialRecordEnvOverridesInteractive", () => {
	it("returns no overrides when not interactive", async () => {
		await expect(
			resolveInitialRecordEnvOverridesInteractive({
				isInteractive: false,
			}),
		).resolves.toEqual({});
	});

	it("returns adaptive overrides when adaptive is chosen", async () => {
		const prompt = vi.fn(async () => "1");
		await expect(
			resolveInitialRecordEnvOverridesInteractive({
				isInteractive: true,
				prompt,
				rawMode: "fixed",
			}),
		).resolves.toEqual({
			HERZEN_RECORD_MODE: "adaptive",
		});
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("returns fixed defaults when fixed is chosen and input is empty", async () => {
		const prompt = vi
			.fn<(_: { message: string; defaultValue: string; timeoutMs: number }) => Promise<string>>()
			.mockResolvedValueOnce("2")
			.mockResolvedValueOnce("");

		await expect(
			resolveInitialRecordEnvOverridesInteractive({
				isInteractive: true,
				prompt,
				rawMode: "fixed",
			}),
		).resolves.toEqual({
			HERZEN_RECORD_MODE: "fixed",
			HERZEN_RECORD_SECONDS: "3",
		});
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(prompt).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				message: "Enter the length (3 default)",
				defaultValue: "3",
			}),
		);
	});

	it("falls back to fixed default when fixed length input is invalid", async () => {
		const prompt = vi
			.fn<(_: { message: string; defaultValue: string; timeoutMs: number }) => Promise<string>>()
			.mockResolvedValueOnce("2")
			.mockResolvedValueOnce("abc");

		await expect(
			resolveInitialRecordEnvOverridesInteractive({
				isInteractive: true,
				prompt,
				rawMode: "fixed",
			}),
		).resolves.toEqual({
			HERZEN_RECORD_MODE: "fixed",
			HERZEN_RECORD_SECONDS: "3",
		});
	});

	it("uses provided fixed length and clamps upper bound", async () => {
		const prompt = vi
			.fn<(_: { message: string; defaultValue: string; timeoutMs: number }) => Promise<string>>()
			.mockResolvedValueOnce("2")
			.mockResolvedValueOnce("120");

		await expect(
			resolveInitialRecordEnvOverridesInteractive({
				isInteractive: true,
				prompt,
				rawMode: "adaptive",
			}),
		).resolves.toEqual({
			HERZEN_RECORD_MODE: "fixed",
			HERZEN_RECORD_SECONDS: "30",
		});
	});
});

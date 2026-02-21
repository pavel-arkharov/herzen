import { describe, expect, it, vi } from "vitest";
import {
	resolveFixedModeEnabled,
	resolveInitialAdaptiveMaxSecondsInteractive,
	resolveInitialRecordingModeInteractive,
	resolveRecordingMode,
} from "../src/recording/factory.js";

describe("resolveRecordingMode", () => {
	it("defaults to adaptive when mode is undefined", () => {
		expect(resolveRecordingMode(undefined)).toBe("adaptive");
	});

	it("normalizes adaptive mode from mixed-case input", () => {
		expect(resolveRecordingMode("  AdApTiVe  ")).toBe("adaptive");
	});

	it("normalizes fixed mode from mixed-case input", () => {
		expect(resolveRecordingMode("  FiXeD  ")).toBe("fixed");
	});

	it("throws for unsupported mode", () => {
		expect(() => resolveRecordingMode("voice")).toThrow('Unsupported record mode "voice"');
	});
});

describe("resolveFixedModeEnabled", () => {
	it("defaults to false when flag is undefined", () => {
		expect(resolveFixedModeEnabled(undefined)).toBe(false);
	});

	it("accepts true-like values", () => {
		expect(resolveFixedModeEnabled("1")).toBe(true);
		expect(resolveFixedModeEnabled("true")).toBe(true);
		expect(resolveFixedModeEnabled("yes")).toBe(true);
		expect(resolveFixedModeEnabled("on")).toBe(true);
	});

	it("rejects false-like and invalid values", () => {
		expect(resolveFixedModeEnabled("0")).toBe(false);
		expect(resolveFixedModeEnabled("false")).toBe(false);
		expect(resolveFixedModeEnabled("no")).toBe(false);
		expect(resolveFixedModeEnabled("nope")).toBe(false);
	});
});

describe("resolveInitialRecordingModeInteractive", () => {
	it("uses env mode as interactive prompt default when fixed mode is enabled", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: "adaptive",
				allowFixedMode: true,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("fixed");

		expect(prompt).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultValue: "1",
			}),
		);
	});

	it("prompts on interactive startup and maps choice 1 to adaptive when fixed mode is enabled", async () => {
		const prompt = vi.fn(async () => "1");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: undefined,
				allowFixedMode: true,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("adaptive");

		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("defaults to adaptive on interactive empty answer", async () => {
		const prompt = vi.fn(async () => "");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: undefined,
				allowFixedMode: true,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("adaptive");
	});

	it("uses env mode when not interactive and fixed mode is enabled", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: "fixed",
				allowFixedMode: true,
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe("fixed");

		expect(prompt).not.toHaveBeenCalled();
	});

	it("defaults to adaptive when not interactive and no mode is set", async () => {
		const prompt = vi.fn(async () => "1");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: undefined,
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe("adaptive");

		expect(prompt).not.toHaveBeenCalled();
	});

	it("returns adaptive and skips prompt when fixed mode is disabled", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: "adaptive",
				allowFixedMode: false,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("adaptive");

		expect(prompt).not.toHaveBeenCalled();
	});

	it("forces adaptive when fixed mode is requested but fixed mode is disabled", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: "fixed",
				allowFixedMode: false,
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe("adaptive");

		expect(prompt).not.toHaveBeenCalled();
	});
});

describe("resolveInitialAdaptiveMaxSecondsInteractive", () => {
	it("uses interactive prompt value", async () => {
		const prompt = vi.fn(async () => "42");

		await expect(
			resolveInitialAdaptiveMaxSecondsInteractive({
				isInteractive: true,
				prompt,
				defaultMaxSeconds: 30,
			}),
		).resolves.toBe(42);
	});

	it("defaults to 60 on empty answer", async () => {
		const prompt = vi.fn(async () => "");

		await expect(
			resolveInitialAdaptiveMaxSecondsInteractive({
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe(60);
	});

	it("falls back to default on invalid interactive value", async () => {
		const prompt = vi.fn(async () => "not-a-number");

		await expect(
			resolveInitialAdaptiveMaxSecondsInteractive({
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe(60);
	});

	it("uses raw max seconds in non-interactive mode", async () => {
		const prompt = vi.fn(async () => "99");

		await expect(
			resolveInitialAdaptiveMaxSecondsInteractive({
				isInteractive: false,
				rawMaxSeconds: "18.5",
				prompt,
			}),
		).resolves.toBe(18.5);

		expect(prompt).not.toHaveBeenCalled();
	});
});

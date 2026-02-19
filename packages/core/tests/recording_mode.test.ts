import { describe, expect, it, vi } from "vitest";
import {
	resolveInitialAdaptiveMaxSecondsInteractive,
	resolveInitialRecordingModeInteractive,
	resolveRecordingMode,
} from "../src/recording/factory.js";

describe("resolveRecordingMode", () => {
	it("defaults to fixed when mode is undefined", () => {
		expect(resolveRecordingMode(undefined)).toBe("fixed");
	});

	it("normalizes adaptive mode from mixed-case input", () => {
		expect(resolveRecordingMode("  AdApTiVe  ")).toBe("adaptive");
	});

	it("throws for unsupported mode", () => {
		expect(() => resolveRecordingMode("voice")).toThrow('Unsupported record mode "voice"');
	});
});

describe("resolveInitialRecordingModeInteractive", () => {
	it("uses env mode as interactive prompt default", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: "adaptive",
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

	it("prompts on interactive startup and maps choice 1 to adaptive", async () => {
		const prompt = vi.fn(async () => "1");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: undefined,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("adaptive");

		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("defaults to fixed on interactive empty answer", async () => {
		const prompt = vi.fn(async () => "");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: undefined,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("fixed");
	});

	it("uses env mode when not interactive", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: "adaptive",
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe("adaptive");

		expect(prompt).not.toHaveBeenCalled();
	});

	it("defaults to fixed when not interactive and no mode is set", async () => {
		const prompt = vi.fn(async () => "1");

		await expect(
			resolveInitialRecordingModeInteractive({
				rawMode: undefined,
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe("fixed");

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

	it("defaults to 30 on empty answer", async () => {
		const prompt = vi.fn(async () => "");

		await expect(
			resolveInitialAdaptiveMaxSecondsInteractive({
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe(30);
	});

	it("falls back to default on invalid interactive value", async () => {
		const prompt = vi.fn(async () => "not-a-number");

		await expect(
			resolveInitialAdaptiveMaxSecondsInteractive({
				isInteractive: true,
				prompt,
				defaultMaxSeconds: 30,
			}),
		).resolves.toBe(30);
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

import { describe, expect, it, vi } from "vitest";
import {
	createTriggerSource,
	resolveInitialTriggerModeInteractive,
	resolveTriggerMode,
	shouldSwitchToStdinAfterWakewordFailure,
} from "../src/trigger/factory.js";
import { StdinTriggerSource } from "../src/trigger/stdin.js";
import { WakeWordTriggerSource } from "../src/trigger/wakeword.js";

describe("resolveTriggerMode", () => {
	it("defaults to stdin when mode is undefined", () => {
		expect(resolveTriggerMode(undefined)).toBe("stdin");
	});

	it("normalizes wakeword mode from mixed-case input", () => {
		expect(resolveTriggerMode("  WakeWord  ")).toBe("wakeword");
	});

	it("throws for unsupported mode", () => {
		expect(() => resolveTriggerMode("keyboard")).toThrow('Unsupported trigger mode "keyboard"');
	});
});

describe("createTriggerSource", () => {
	it("creates stdin source", () => {
		expect(createTriggerSource("stdin")).toBeInstanceOf(StdinTriggerSource);
	});

	it("creates wakeword source", () => {
		expect(createTriggerSource("wakeword")).toBeInstanceOf(WakeWordTriggerSource);
	});
});

describe("resolveInitialTriggerModeInteractive", () => {
	it("uses valid env mode and skips prompt", async () => {
		const prompt = vi.fn(async () => "2");

		await expect(
			resolveInitialTriggerModeInteractive({
				rawMode: "wakeword",
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("wakeword");

		expect(prompt).not.toHaveBeenCalled();
	});

	it("prompts on interactive startup and maps choice 1 to wakeword", async () => {
		const prompt = vi.fn(async () => "1");

		await expect(
			resolveInitialTriggerModeInteractive({
				rawMode: undefined,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("wakeword");

		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("defaults to stdin on interactive empty answer", async () => {
		const prompt = vi.fn(async () => "");

		await expect(
			resolveInitialTriggerModeInteractive({
				rawMode: undefined,
				isInteractive: true,
				prompt,
			}),
		).resolves.toBe("stdin");
	});

	it("defaults to stdin when not interactive and no env mode", async () => {
		const prompt = vi.fn(async () => "1");

		await expect(
			resolveInitialTriggerModeInteractive({
				rawMode: undefined,
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe("stdin");

		expect(prompt).not.toHaveBeenCalled();
	});
});

describe("shouldSwitchToStdinAfterWakewordFailure", () => {
	it("defaults to yes on empty answer", async () => {
		await expect(
			shouldSwitchToStdinAfterWakewordFailure({
				isInteractive: true,
				prompt: async () => "",
			}),
		).resolves.toBe(true);
	});

	it("returns false for explicit no answer", async () => {
		await expect(
			shouldSwitchToStdinAfterWakewordFailure({
				isInteractive: true,
				prompt: async () => "n",
			}),
		).resolves.toBe(false);
	});

	it("does not prompt in non-interactive mode", async () => {
		const prompt = vi.fn(async () => "y");

		await expect(
			shouldSwitchToStdinAfterWakewordFailure({
				isInteractive: false,
				prompt,
			}),
		).resolves.toBe(false);

		expect(prompt).not.toHaveBeenCalled();
	});
});

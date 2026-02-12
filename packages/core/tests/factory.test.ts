import { describe, expect, it } from "vitest";
import { createTriggerSource, resolveTriggerMode } from "../src/trigger/factory.js";
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

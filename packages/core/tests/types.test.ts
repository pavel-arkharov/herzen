import { describe, expect, it } from "vitest";
import { TriggerError, isTriggerError } from "../src/trigger/types.js";

describe("TriggerError", () => {
	it("stores code and cause details", () => {
		const cause = new Error("underlying failure");
		const err = new TriggerError("SOURCE_FAILED", "source failed", { cause });

		expect(err.name).toBe("TriggerError");
		expect(err.code).toBe("SOURCE_FAILED");
		expect((err as Error & { cause?: unknown }).cause).toBe(cause);
	});
});

describe("isTriggerError", () => {
	it("returns true for TriggerError instances", () => {
		expect(isTriggerError(new TriggerError("SOURCE_CLOSED", "closed"))).toBe(true);
	});

	it("returns false for non-TriggerError values", () => {
		expect(isTriggerError(new Error("generic"))).toBe(false);
		expect(isTriggerError("error")).toBe(false);
		expect(isTriggerError(null)).toBe(false);
	});
});

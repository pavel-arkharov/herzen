import { describe, expect, it } from "vitest";
import { printableWidth, truncateAnsi, wrapAnsi } from "../src/ansi_layout.js";

describe("ansi layout helpers", () => {
	it("measures printable width without counting ANSI sequences", () => {
		expect(printableWidth("\x1b[31mRED\x1b[0m")).toBe(3);
	});

	it("truncates without cutting ANSI sequence boundaries", () => {
		const rendered = truncateAnsi("\x1b[31mVery long red line\x1b[0m", 10);
		expect(rendered).toContain("...");
		expect(rendered).toContain("\x1b[31m");
		expect(rendered.endsWith("\x1b[0m")).toBe(true);
		expect(printableWidth(rendered)).toBeLessThanOrEqual(10);
	});

	it("wraps long lines instead of truncating", () => {
		const wrapped = wrapAnsi("very long line for wrapping", 8);
		expect(wrapped.length).toBeGreaterThan(1);
		for (const line of wrapped) {
			expect(printableWidth(line)).toBeLessThanOrEqual(8);
			expect(line).not.toContain("...");
		}
	});

	it("wraps ANSI-colored text without breaking width guarantees", () => {
		const wrapped = wrapAnsi("\x1b[31mVery long red line\x1b[0m", 6);
		expect(wrapped.length).toBeGreaterThan(1);
		for (const line of wrapped) {
			expect(printableWidth(line)).toBeLessThanOrEqual(6);
		}
		expect(wrapped.join("")).toContain("\x1b[31m");
	});
});

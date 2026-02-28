import { describe, expect, it, vi } from "vitest";
import { resolveContextBudget, trimToCharBudget } from "../src/context/budget.js";

describe("context budget", () => {
	it("parses env overrides with fallback behavior", () => {
		const warn = vi.fn();
		const budget = resolveContextBudget(
			{
				HERZEN_CONTEXT_BUDGET_TOTAL_CHARS: "7000",
				HERZEN_CONTEXT_BUDGET_KERNEL_CHARS: "bad",
				HERZEN_CONTEXT_BUDGET_SUMMARY_CHARS: "1200",
				HERZEN_CONTEXT_BUDGET_RECENT_TURNS_CHARS: "2200",
				HERZEN_CONTEXT_BUDGET_MEMORY_CHARS: "1300",
				HERZEN_CONTEXT_BUDGET_CURRENT_INPUT_CHARS: "600",
			},
			{ warn },
		);

		expect(budget.totalChars).toBe(7000);
		expect(budget.kernelChars).toBe(900);
		expect(budget.summaryChars).toBe(1200);
		expect(warn).toHaveBeenCalled();
	});

	it("trims text to configured char ceiling", () => {
		expect(trimToCharBudget("abcdef", 3)).toBe("abc");
		expect(trimToCharBudget("abcdef", 4)).toBe("a...");
		expect(trimToCharBudget("abcdef", 10)).toBe("abcdef");
	});
});

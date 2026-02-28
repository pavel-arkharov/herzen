import { describe, expect, it } from "vitest";
import {
	ENTER_ALT_SCREEN,
	EXIT_ALT_SCREEN,
	HOME_AND_CLEAR,
	TerminalViewport,
} from "../src/terminal_viewport.js";

describe("terminal viewport", () => {
	it("enters and exits alternate screen exactly once", () => {
		const writes: string[] = [];
		const viewport = new TerminalViewport({
			write: (chunk: string) => {
				writes.push(chunk);
			},
		});

		viewport.enter();
		viewport.enter();
		viewport.exit();
		viewport.exit();

		expect(writes).toEqual([ENTER_ALT_SCREEN, EXIT_ALT_SCREEN]);
	});

	it("suppresses unchanged frame writes", () => {
		const writes: string[] = [];
		const viewport = new TerminalViewport({
			write: (chunk: string) => {
				writes.push(chunk);
			},
		});

		const first = viewport.render("Herzen Operator TUI\n");
		const second = viewport.render("Herzen Operator TUI\n");
		const third = viewport.render("Herzen Operator TUI v2\n");

		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(third).toBe(true);
		expect(writes).toEqual([
			ENTER_ALT_SCREEN,
			`${HOME_AND_CLEAR}Herzen Operator TUI\n`,
			`${HOME_AND_CLEAR}Herzen Operator TUI v2\n`,
		]);
	});
});

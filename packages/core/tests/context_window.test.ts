import { describe, expect, it, vi } from "vitest";
import { ConversationContextWindow, resolveContextWindowConfig } from "../src/context_window.js";

describe("ConversationContextWindow", () => {
	it("keeps context items in chronological append order", () => {
		const window = new ConversationContextWindow({
			enabled: true,
			maxTurns: 6,
			maxChars: 4_000,
		});

		window.appendUser(1, "My name is Pavel.", "en");
		window.appendAssistant(1, "Nice to meet you, Pavel.", "en");
		window.appendUser(2, "What is my name?", "en");

		expect(window.snapshot()).toEqual([
			{ role: "user", text: "My name is Pavel.", language: "en", turn: 1 },
			{ role: "assistant", text: "Nice to meet you, Pavel.", language: "en", turn: 1 },
			{ role: "user", text: "What is my name?", language: "en", turn: 2 },
		]);
	});

	it("trims the oldest turns first when max turn cap is exceeded", () => {
		const window = new ConversationContextWindow({
			enabled: true,
			maxTurns: 2,
			maxChars: 4_000,
		});

		window.appendUser(1, "turn-1-user");
		window.appendAssistant(1, "turn-1-assistant");
		window.appendUser(2, "turn-2-user");
		window.appendAssistant(2, "turn-2-assistant");
		window.appendUser(3, "turn-3-user");

		expect(window.snapshot()).toEqual([
			{ role: "user", text: "turn-2-user", turn: 2 },
			{ role: "assistant", text: "turn-2-assistant", turn: 2 },
			{ role: "user", text: "turn-3-user", turn: 3 },
		]);
	});

	it("applies max char trimming after turn trimming", () => {
		const window = new ConversationContextWindow({
			enabled: true,
			maxTurns: 6,
			maxChars: 20,
		});

		window.appendUser(1, "abcdefghij");
		window.appendAssistant(1, "klmnopqrst");
		window.appendUser(2, "uvwxy");

		expect(window.snapshot()).toEqual([{ role: "user", text: "uvwxy", turn: 2 }]);
	});

	it("returns stable snapshots and protects internal state from mutations", () => {
		const window = new ConversationContextWindow({
			enabled: true,
			maxTurns: 6,
			maxChars: 4_000,
		});
		window.appendUser(1, "first");
		window.appendAssistant(1, "second");

		const first = window.snapshot();
		first[0]!.text = "mutated";
		const second = window.snapshot();

		expect(second).toEqual([
			{ role: "user", text: "first", turn: 1 },
			{ role: "assistant", text: "second", turn: 1 },
		]);
	});

	it("is a no-op when disabled", () => {
		const window = new ConversationContextWindow({
			enabled: false,
			maxTurns: 6,
			maxChars: 4_000,
		});

		window.appendUser(1, "hi");
		window.appendAssistant(1, "hello");

		expect(window.snapshot()).toEqual([]);
	});
});

describe("resolveContextWindowConfig", () => {
	it("uses defaults when values are not set", () => {
		expect(resolveContextWindowConfig({})).toEqual({
			enabled: true,
			maxTurns: 6,
			maxChars: 4_000,
		});
	});

	it("disables context with HERZEN_CONTEXT_ENABLED=0", () => {
		expect(resolveContextWindowConfig({ HERZEN_CONTEXT_ENABLED: "0" }).enabled).toBe(false);
	});

	it("falls back to defaults for invalid numeric values and warns", () => {
		const warn = vi.fn();
		const config = resolveContextWindowConfig(
			{
				HERZEN_CONTEXT_MAX_TURNS: "0",
				HERZEN_CONTEXT_MAX_CHARS: "abc",
			},
			{ warn },
		);

		expect(config).toEqual({
			enabled: true,
			maxTurns: 6,
			maxChars: 4_000,
		});
		expect(warn).toHaveBeenCalledTimes(2);
	});
});

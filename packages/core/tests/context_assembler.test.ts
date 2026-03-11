import { describe, expect, it } from "vitest";
import { createContextAssembler } from "../src/context/assembler.js";

describe("context assembler", () => {
	it("assembles slices in deterministic order", () => {
		const assembler = createContextAssembler({
			totalChars: 10_000,
			kernelChars: 500,
			summaryChars: 500,
			recentTurnsChars: 5_000,
			memoryChars: 2_000,
			currentInputReserveChars: 500,
		});

		const assembled = assembler.assemble({
			kernelPrompt: "kernel policy",
			summary: {
				schemaVersion: "context.summary.v1",
				sessionId: "session-1",
				updatedAt: "2026-02-27T00:00:00.000Z",
				summary: "summary text",
				sourceEventIds: ["turn:1:user"],
			},
			recentTurns: [
				{ role: "user", text: "hello", turn: 1 },
				{ role: "assistant", text: "hi", turn: 1 },
				{ role: "user", text: "turn on kitchen", turn: 2 },
			],
			memoryFacts: [{ text: "User prefers concise responses.", sourceEventId: "memory:1" }],
			currentInput: "what is next",
		});

		expect(assembled.slices.map((slice) => slice.kind)).toEqual([
			"kernel",
			"session_summary",
			"recent_turn",
			"recent_turn",
			"recent_turn",
			"memory_fact",
			"current_input",
		]);
		expect(assembled.conversationContext.map((item) => item.role)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(assembled.overflow).toBe(false);
	});

	it("enforces fixed budgets and reports overflow", () => {
		const assembler = createContextAssembler({
			totalChars: 40,
			kernelChars: 10,
			summaryChars: 10,
			recentTurnsChars: 10,
			memoryChars: 5,
			currentInputReserveChars: 5,
		});

		const assembled = assembler.assemble({
			kernelPrompt: "123456789012345",
			summary: {
				schemaVersion: "context.summary.v1",
				sessionId: "session-1",
				updatedAt: "2026-02-27T00:00:00.000Z",
				summary: "abcdefghijklm",
				sourceEventIds: [],
			},
			recentTurns: [{ role: "user", text: "recent turn text", turn: 1 }],
			memoryFacts: [{ text: "memory text" }],
			currentInput: "current input long",
		});

		expect(assembled.totalChars).toBeLessThanOrEqual(40);
		expect(assembled.overflow).toBe(true);
	});
});

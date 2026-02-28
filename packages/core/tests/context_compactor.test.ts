import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createContextCompactor } from "../src/context/compactor.js";
import { createSessionSummaryStore } from "../src/context/summary.js";

describe("context compactor", () => {
	it("compacts on turn-count trigger and persists summary artifact", async () => {
		const root = mkdtempSync(join(tmpdir(), "herzen-context-"));
		const summaryStore = createSessionSummaryStore({
			conversationsDir: root,
			sessionId: "session-1",
		});
		const compactor = createContextCompactor({
			sessionId: "session-1",
			summaryStore,
			nowIso: () => "2026-02-27T00:00:00.000Z",
			policy: {
				turnCountTrigger: 2,
				prunedUserTurns: 1,
			},
		});

		const recentTurns = [
			{ role: "user", text: "turn on kitchen", turn: 1 as const },
			{ role: "assistant", text: "Done.", turn: 1 as const },
			{ role: "user", text: "turn off living room", turn: 2 as const },
		];

		const first = await compactor.maybeCompact({
			turn: 1,
			recentTurns,
			overflow: false,
			summaryCharBudget: 200,
		});
		expect(first.compacted).toBe(false);

		const second = await compactor.maybeCompact({
			turn: 2,
			recentTurns,
			overflow: false,
			summaryCharBudget: 200,
		});
		expect(second.compacted).toBe(true);
		expect(second.reason).toBe("turn_count");
		expect(second.summary?.sourceEventIds).toEqual([
			"turn:1:assistant",
			"turn:2:user",
		]);
		expect(second.prunedRecentTurns).toEqual([
			{ role: "user", text: "turn off living room", turn: 2 },
		]);

		const persisted = summaryStore.read();
		expect(persisted?.schemaVersion).toBe("context.summary.v1");
		expect(persisted?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
	});

	it("compacts immediately on overflow", async () => {
		const root = mkdtempSync(join(tmpdir(), "herzen-context-overflow-"));
		const compactor = createContextCompactor({
			sessionId: "session-2",
			summaryStore: createSessionSummaryStore({
				conversationsDir: root,
				sessionId: "session-2",
			}),
		});

		const result = await compactor.maybeCompact({
			turn: 1,
			recentTurns: [{ role: "user", text: "long turn", turn: 1 }],
			overflow: true,
			summaryCharBudget: 120,
		});

		expect(result.compacted).toBe(true);
		expect(result.reason).toBe("overflow");
		expect(result.summary?.sourceEventIds).toContain("turn:1:user");
	});
});

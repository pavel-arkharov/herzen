import type { ConversationContextItem } from "@herzen/dialog";
import { trimToCharBudget } from "./budget.js";
import type { SessionSummaryArtifactV1, SessionSummaryStore } from "./summary.js";

const DEFAULT_TURNS_SINCE_SUMMARY_TRIGGER = 6;
const DEFAULT_PRUNED_USER_TURNS = 3;

export interface ContextCompactorPolicy {
	turnCountTrigger: number;
	prunedUserTurns: number;
}

export interface ContextCompactionInput {
	turn: number;
	recentTurns: ConversationContextItem[];
	overflow: boolean;
	summaryCharBudget: number;
}

export interface ContextCompactionResult {
	compacted: boolean;
	reason?: "turn_count" | "overflow";
	summary: SessionSummaryArtifactV1 | null;
	prunedRecentTurns: ConversationContextItem[];
	sourceEventIds: string[];
}

export interface ContextCompactor {
	getSummary: () => SessionSummaryArtifactV1 | null;
	maybeCompact: (input: ContextCompactionInput) => Promise<ContextCompactionResult>;
}

export interface CreateContextCompactorOptions {
	sessionId: string;
	summaryStore: SessionSummaryStore;
	nowIso?: () => string;
	policy?: Partial<ContextCompactorPolicy>;
}

export function createContextCompactor(options: CreateContextCompactorOptions): ContextCompactor {
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	const policy: ContextCompactorPolicy = {
		turnCountTrigger: Math.max(1, options.policy?.turnCountTrigger ?? DEFAULT_TURNS_SINCE_SUMMARY_TRIGGER),
		prunedUserTurns: Math.max(1, options.policy?.prunedUserTurns ?? DEFAULT_PRUNED_USER_TURNS),
	};
	let summary = options.summaryStore.read();
	let turnsSinceSummary = 0;

	return {
		getSummary: () => summary,
		maybeCompact: async (input) => {
			turnsSinceSummary += 1;
			const reason = resolveCompactionReason(input.overflow, turnsSinceSummary, policy.turnCountTrigger);
			if (!reason) {
				return {
					compacted: false,
					summary,
					prunedRecentTurns: input.recentTurns,
					sourceEventIds: [],
				};
			}

			const selectedTurns = selectSummaryTurns(input.recentTurns, policy.prunedUserTurns * 2);
			const sourceEventIds = selectedTurns.flatMap((item) => toSourceEventIds(item));
			if (sourceEventIds.length === 0) {
				sourceEventIds.push(`turn:${input.turn}:compaction`);
			}
			const summaryText = buildSummaryText(selectedTurns, input.summaryCharBudget);
			summary = {
				schemaVersion: "context.summary.v1",
				sessionId: options.sessionId,
				updatedAt: nowIso(),
				summary: summaryText,
				sourceEventIds,
			};
			turnsSinceSummary = 0;
			await options.summaryStore.write(summary);

			return {
				compacted: true,
				reason,
				summary,
				prunedRecentTurns: pruneRecentTurns(input.recentTurns, policy.prunedUserTurns),
				sourceEventIds,
			};
		},
	};
}

function resolveCompactionReason(
	overflow: boolean,
	turnsSinceSummary: number,
	turnCountTrigger: number,
): "turn_count" | "overflow" | null {
	if (overflow) return "overflow";
	if (turnsSinceSummary >= turnCountTrigger) return "turn_count";
	return null;
}

function selectSummaryTurns(items: ConversationContextItem[], maxItems: number): ConversationContextItem[] {
	if (maxItems <= 0) return [];
	const selected = items.slice(-maxItems).map((item) => ({
		...item,
		text: item.text.trim(),
	}));
	return selected.filter((item) => item.text.length > 0);
}

function buildSummaryText(items: ConversationContextItem[], maxChars: number): string {
	if (items.length === 0) {
		return trimToCharBudget("No recent turns to summarize.", maxChars);
	}

	const lines: string[] = [];
	for (const item of items) {
		const prefix = item.role === "user" ? "User" : "Assistant";
		const turn = typeof item.turn === "number" ? `#${item.turn}` : "#?";
		lines.push(`${prefix} ${turn}: ${item.text}`);
	}

	return trimToCharBudget(lines.join(" | "), maxChars);
}

function pruneRecentTurns(items: ConversationContextItem[], keepUserTurns: number): ConversationContextItem[] {
	if (keepUserTurns <= 0) return [];
	const keepTurns = new Set<number>();

	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (!item || item.role !== "user" || typeof item.turn !== "number") continue;
		keepTurns.add(item.turn);
		if (keepTurns.size >= keepUserTurns) break;
	}

	if (keepTurns.size === 0) return [];
	return items.filter((item) => typeof item.turn === "number" && keepTurns.has(item.turn));
}

function toSourceEventIds(item: ConversationContextItem): string[] {
	if (typeof item.turn !== "number") return [];
	return [`turn:${item.turn}:${item.role}`];
}

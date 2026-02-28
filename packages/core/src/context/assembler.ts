import type { ConversationContextItem } from "@herzen/dialog";
import { trimToCharBudget, type ContextBudget } from "./budget.js";
import type { SessionSummaryArtifactV1 } from "./summary.js";

export interface ContextMemoryFact {
	text: string;
	sourceEventId?: string;
}

export interface ContextAssemblerInput {
	kernelPrompt: string;
	summary: SessionSummaryArtifactV1 | null;
	recentTurns: ConversationContextItem[];
	memoryFacts?: ContextMemoryFact[];
	currentInput: string;
}

export type ContextSliceKind =
	| "kernel"
	| "session_summary"
	| "recent_turn"
	| "memory_fact"
	| "current_input";

export interface ContextSlice {
	kind: ContextSliceKind;
	text: string;
	charCount: number;
	turn?: number;
	sourceEventIds?: string[];
	truncated?: boolean;
}

export interface AssembledContext {
	conversationContext: ConversationContextItem[];
	slices: ContextSlice[];
	overflow: boolean;
	totalChars: number;
}

export interface ContextAssembler {
	assemble: (input: ContextAssemblerInput) => AssembledContext;
}

export function createContextAssembler(budget: ContextBudget): ContextAssembler {
	return {
		assemble: (input) => {
			let remainingTotal = budget.totalChars;
			const slices: ContextSlice[] = [];
			const contextItems: ConversationContextItem[] = [];
			let overflow = false;

			const appendSlice = (
				slice: Omit<ContextSlice, "charCount">,
				item?: ConversationContextItem,
			): void => {
				const charCount = slice.text.length;
				slices.push({
					...slice,
					charCount,
				});
				if (item) contextItems.push(item);
				remainingTotal = Math.max(0, remainingTotal - charCount);
				if (slice.truncated) overflow = true;
			};

			const appendBoundedSlice = (
				kind: ContextSliceKind,
				text: string,
				sliceBudget: number,
				item?: ConversationContextItem,
				extra?: Omit<ContextSlice, "kind" | "text" | "charCount" | "truncated">,
			): void => {
				const available = Math.max(0, Math.min(sliceBudget, remainingTotal));
				if (available <= 0) {
					if (text.length > 0) overflow = true;
					return;
				}
				const normalized = text.trim();
				if (!normalized) return;
				const bounded = trimToCharBudget(normalized, available);
				appendSlice(
					{
						kind,
						text: bounded,
						truncated: bounded.length < normalized.length,
						...extra,
					},
					item ? { ...item, text: bounded } : undefined,
				);
			};

			appendBoundedSlice(
				"kernel",
				input.kernelPrompt,
				budget.kernelChars,
				{
					role: "assistant",
					text: input.kernelPrompt,
				},
			);

			if (input.summary) {
				appendBoundedSlice(
					"session_summary",
					input.summary.summary,
					budget.summaryChars,
					{
						role: "assistant",
						text: input.summary.summary,
					},
					{
						sourceEventIds: input.summary.sourceEventIds,
					},
				);
			}

			const recentTurnItems = takeRecentTurnSlice(input.recentTurns, budget.recentTurnsChars, remainingTotal);
			if (recentTurnItems.truncated) overflow = true;
			for (const item of recentTurnItems.items) {
				appendSlice(
					{
						kind: "recent_turn",
						text: item.text,
						turn: item.turn,
						sourceEventIds: toSourceEventIds(item),
					},
					item,
				);
			}

			const memoryFacts = input.memoryFacts ?? [];
			let memoryUsedChars = 0;
			for (const fact of memoryFacts) {
				const available = Math.max(0, Math.min(budget.memoryChars - memoryUsedChars, remainingTotal));
				if (available <= 0) {
					overflow = true;
					break;
				}
				const text = fact.text.trim();
				if (!text) continue;
				const bounded = trimToCharBudget(text, available);
				if (bounded.length < text.length) overflow = true;
				memoryUsedChars += bounded.length;
				appendSlice(
					{
						kind: "memory_fact",
						text: bounded,
						sourceEventIds: fact.sourceEventId ? [fact.sourceEventId] : undefined,
						truncated: bounded.length < text.length,
					},
					{
						role: "assistant",
						text: bounded,
					},
				);
			}

			appendBoundedSlice("current_input", input.currentInput, budget.currentInputReserveChars, undefined);

			return {
				conversationContext: contextItems,
				slices,
				overflow,
				totalChars: slices.reduce((sum, slice) => sum + slice.charCount, 0),
			};
		},
	};
}

function takeRecentTurnSlice(
	items: ConversationContextItem[],
	sliceBudget: number,
	remainingTotal: number,
): {
	items: ConversationContextItem[];
	truncated: boolean;
} {
	const budget = Math.max(0, Math.min(sliceBudget, remainingTotal));
	if (budget <= 0 || items.length === 0) {
		return {
			items: [],
			truncated: items.length > 0,
		};
	}

	let used = 0;
	const selected: ConversationContextItem[] = [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (!item) continue;
		const text = item.text.trim();
		if (!text) continue;
		if (used + text.length > budget) break;
		used += text.length;
		selected.push({
			...item,
			text,
		});
	}

	selected.reverse();
	return {
		items: selected,
		truncated: selected.length < items.filter((item) => item.text.trim().length > 0).length,
	};
}

function toSourceEventIds(item: ConversationContextItem): string[] {
	if (typeof item.turn !== "number") return [];
	return [`turn:${item.turn}:${item.role}`];
}

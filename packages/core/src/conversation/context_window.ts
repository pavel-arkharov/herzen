import type { ConversationContextItem, ResponseLanguage } from "@herzen/dialog";

const DEFAULT_CONTEXT_ENABLED = true;
const DEFAULT_CONTEXT_MAX_TURNS = 6;
const DEFAULT_CONTEXT_MAX_CHARS = 4000;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export interface ContextWindowConfig {
	enabled: boolean;
	maxTurns: number;
	maxChars: number;
}

export interface ContextWindowConfigLogger {
	warn: (...args: unknown[]) => void;
}

export function resolveContextWindowConfig(
	env: NodeJS.ProcessEnv = process.env,
	logger?: ContextWindowConfigLogger,
): ContextWindowConfig {
	return {
		enabled: resolveEnabledFlag(env.HERZEN_CONTEXT_ENABLED, logger),
		maxTurns: resolvePositiveInteger(
			env.HERZEN_CONTEXT_MAX_TURNS,
			DEFAULT_CONTEXT_MAX_TURNS,
			"HERZEN_CONTEXT_MAX_TURNS",
			logger,
		),
		maxChars: resolvePositiveInteger(
			env.HERZEN_CONTEXT_MAX_CHARS,
			DEFAULT_CONTEXT_MAX_CHARS,
			"HERZEN_CONTEXT_MAX_CHARS",
			logger,
		),
	};
}

export class ConversationContextWindow {
	private readonly config: ContextWindowConfig;
	private items: ConversationContextItem[] = [];

	constructor(config: ContextWindowConfig) {
		this.config = sanitizeConfig(config);
	}

	appendUser(turn: number, text: string, language?: ResponseLanguage): void {
		this.append("user", turn, text, language);
	}

	appendAssistant(turn: number, text: string, language?: ResponseLanguage): void {
		this.append("assistant", turn, text, language);
	}

	snapshot(): ConversationContextItem[] {
		if (!this.config.enabled) return [];
		return this.items.map((item) => ({ ...item }));
	}

	clear(): void {
		this.items = [];
	}

	replace(items: ConversationContextItem[]): void {
		if (!this.config.enabled) {
			this.items = [];
			return;
		}
		this.items = items
			.map((item) => ({
				...item,
				text: item.text.trim(),
			}))
			.filter((item) => item.text.length > 0);
		this.trimToLimits();
	}

	private append(
		role: ConversationContextItem["role"],
		turn: number,
		text: string,
		language?: ResponseLanguage,
	): void {
		if (!this.config.enabled) return;

		const normalized = text.trim();
		if (!normalized) return;

		this.items.push({
			role,
			text: normalized,
			language,
			turn,
		});

		this.trimToLimits();
	}

	private trimToLimits(): void {
		this.trimByTurnLimit();
		this.trimByCharLimit();
	}

	private trimByTurnLimit(): void {
		while (countUserTurns(this.items) > this.config.maxTurns) {
			const oldestTurn = findOldestUserTurn(this.items);
			if (oldestTurn === undefined) break;
			this.items = this.items.filter((item) => item.turn !== oldestTurn);
		}
	}

	private trimByCharLimit(): void {
		while (totalChars(this.items) > this.config.maxChars && this.items.length > 0) {
			const oldestTurn = this.items[0]?.turn;
			if (typeof oldestTurn === "number") {
				this.items = this.items.filter((item) => item.turn !== oldestTurn);
				continue;
			}
			this.items.shift();
		}
	}
}

function sanitizeConfig(config: ContextWindowConfig): ContextWindowConfig {
	return {
		enabled: config.enabled,
		maxTurns:
			Number.isInteger(config.maxTurns) && config.maxTurns > 0
				? config.maxTurns
				: DEFAULT_CONTEXT_MAX_TURNS,
		maxChars:
			Number.isInteger(config.maxChars) && config.maxChars > 0
				? config.maxChars
				: DEFAULT_CONTEXT_MAX_CHARS,
	};
}

function resolveEnabledFlag(rawValue: string | undefined, logger?: ContextWindowConfigLogger): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return DEFAULT_CONTEXT_ENABLED;
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;

	logger?.warn(
		`Invalid HERZEN_CONTEXT_ENABLED "${rawValue}". Falling back to ${DEFAULT_CONTEXT_ENABLED ? "1" : "0"}.`,
	);
	return DEFAULT_CONTEXT_ENABLED;
}

function resolvePositiveInteger(
	rawValue: string | undefined,
	fallback: number,
	envName: string,
	logger?: ContextWindowConfigLogger,
): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;

	if (!/^\d+$/.test(trimmed)) {
		logger?.warn(`Invalid ${envName} "${rawValue}". Falling back to ${fallback}.`);
		return fallback;
	}

	const parsed = Number(trimmed);
	if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;

	logger?.warn(`Invalid ${envName} "${rawValue}". Falling back to ${fallback}.`);
	return fallback;
}

function countUserTurns(items: ConversationContextItem[]): number {
	const turns = new Set<number>();
	for (const item of items) {
		if (item.role !== "user") continue;
		if (typeof item.turn !== "number") continue;
		turns.add(item.turn);
	}
	return turns.size;
}

function findOldestUserTurn(items: ConversationContextItem[]): number | undefined {
	for (const item of items) {
		if (item.role !== "user") continue;
		if (typeof item.turn !== "number") continue;
		return item.turn;
	}
	return undefined;
}

function totalChars(items: ConversationContextItem[]): number {
	let chars = 0;
	for (const item of items) {
		chars += item.text.length;
	}
	return chars;
}

const DEFAULT_FOLLOWUP_ENABLED = false;
const DEFAULT_FOLLOWUP_WINDOW_SECONDS = 8;
const DEFAULT_FOLLOWUP_MAX_TURNS = 3;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const EDGE_TRIM_REGEX = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

export interface FollowupConfig {
	enabled: boolean;
	windowSeconds: number;
	maxTurns: number;
	stopPhrases: string[];
}

export interface FollowupConfigLogger {
	warn: (...args: unknown[]) => void;
}

export function resolveFollowupConfig(
	env: NodeJS.ProcessEnv = process.env,
	logger?: FollowupConfigLogger,
): FollowupConfig {
	return {
		enabled: resolveEnabledFlag(env.HERZEN_FOLLOWUP_ENABLED, logger),
		windowSeconds: resolvePositiveFiniteNumber(
			env.HERZEN_FOLLOWUP_WINDOW_SECONDS,
			DEFAULT_FOLLOWUP_WINDOW_SECONDS,
			"HERZEN_FOLLOWUP_WINDOW_SECONDS",
			logger,
		),
		maxTurns: resolvePositiveInteger(
			env.HERZEN_FOLLOWUP_MAX_TURNS,
			DEFAULT_FOLLOWUP_MAX_TURNS,
			"HERZEN_FOLLOWUP_MAX_TURNS",
			logger,
		),
		stopPhrases: parseStopPhrases(env.HERZEN_FOLLOWUP_STOP_PHRASES),
	};
}

export function parseStopPhrases(rawValue: string | undefined): string[] {
	if (!rawValue) return [];
	const unique = new Set<string>();
	for (const token of rawValue.split(",")) {
		const normalized = normalizeFollowupPhrase(token);
		if (!normalized) continue;
		unique.add(normalized);
	}
	return [...unique];
}

export function normalizeFollowupPhrase(value: string): string {
	return value.toLocaleLowerCase().replace(EDGE_TRIM_REGEX, "").trim();
}

export function isFollowupStopPhrase(transcript: string, stopPhrases: string[]): boolean {
	if (stopPhrases.length === 0) return false;
	const normalized = normalizeFollowupPhrase(transcript);
	if (!normalized) return false;
	return stopPhrases.includes(normalized);
}

function resolveEnabledFlag(
	rawValue: string | undefined,
	logger?: FollowupConfigLogger,
): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return DEFAULT_FOLLOWUP_ENABLED;
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;

	logger?.warn(
		`Invalid HERZEN_FOLLOWUP_ENABLED "${rawValue}". Falling back to ${DEFAULT_FOLLOWUP_ENABLED ? "1" : "0"}.`,
	);
	return DEFAULT_FOLLOWUP_ENABLED;
}

function resolvePositiveFiniteNumber(
	rawValue: string | undefined,
	fallback: number,
	envName: string,
	logger?: FollowupConfigLogger,
): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;

	logger?.warn(`Invalid ${envName} "${rawValue}". Falling back to ${fallback}.`);
	return fallback;
}

function resolvePositiveInteger(
	rawValue: string | undefined,
	fallback: number,
	envName: string,
	logger?: FollowupConfigLogger,
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

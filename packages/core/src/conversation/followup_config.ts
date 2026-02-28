import { resolveSettings } from "../settings/registry.js";

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
	void logger;
	const settings = resolveSettings(env).followup;
	return {
		enabled: settings.enabled,
		windowSeconds: settings.windowSeconds,
		maxTurns: settings.maxTurns,
		stopPhrases: settings.stopPhrases,
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

import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getSettingMeta,
	resolveSettings,
	type ResolvedSettings,
	type SettingsKey,
} from "@herzen/core/settings/registry";

export const EDITABLE_SETTING_KEYS: SettingsKey[] = [
	"logging.level",
	"logging.transcript_enabled",
	"logging.perf_enabled",
	"followup.enabled",
];

export interface RuntimeSettingItem {
	key: SettingsKey;
	envName: string;
	value: string;
	mutability: "runtime" | "restart_required";
	sensitive: boolean;
}

export function runtimeSettingsFilePath(dataRoot: string): string {
	return join(dataRoot, "control", "runtime_settings.json");
}

export function loadRuntimeOverrides(filePath: string): Record<string, string> {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}

	if (typeof parsed !== "object" || parsed === null) return {};
	const entries = Object.entries(parsed as Record<string, unknown>);
	const result: Record<string, string> = {};
	for (const [key, value] of entries) {
		if (typeof value !== "string") continue;
		result[key] = value;
	}
	return result;
}

export async function saveRuntimeOverrides(
	filePath: string,
	overrides: Record<string, string>,
): Promise<void> {
	const directory = dirname(filePath);
	mkdirSync(directory, { recursive: true });
	const tempPath = `${filePath}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
	await rename(tempPath, filePath);
}

export function resolveRuntimeSettingItems(
	env: NodeJS.ProcessEnv,
	overrides: Record<string, string>,
): RuntimeSettingItem[] {
	const mergedEnv: NodeJS.ProcessEnv = {
		...env,
		...overrides,
	};
	const settings = resolveSettings(mergedEnv);
	return EDITABLE_SETTING_KEYS.map((key) => {
		const meta = getSettingMeta(key);
		const value = resolveSettingValue(settings, key);
		return {
			key,
			envName: meta.envName,
			value: toDisplayValue(value),
			mutability: meta.mutability,
			sensitive: meta.sensitive,
		};
	});
}

export function setRuntimeSettingOverride(
	overrides: Record<string, string>,
	key: SettingsKey,
	value: string,
): Record<string, string> {
	const meta = getSettingMeta(key);
	return {
		...overrides,
		[meta.envName]: value,
	};
}

function resolveSettingValue(settings: ResolvedSettings, key: SettingsKey): unknown {
	switch (key) {
		case "logging.level":
			return settings.logging.level;
		case "logging.transcript_enabled":
			return settings.logging.transcriptEnabled;
		case "logging.audio_input_enabled":
			return settings.logging.audioInputEnabled;
		case "logging.dialog_enabled":
			return settings.logging.dialogEnabled;
		case "logging.dialog_markdown_enabled":
			return settings.logging.dialogMarkdownEnabled;
		case "logging.perf_enabled":
			return settings.logging.perfEnabled;
		case "logging.perf_sample_ms":
			return settings.logging.perfSampleMs;
		case "logging.retention_enabled":
			return settings.logging.retentionEnabled;
		case "logging.retention_max_bytes":
			return settings.logging.retentionMaxBytes;
		case "logging.retention_max_age_days":
			return settings.logging.retentionMaxAgeDays;
		case "logging.retention_prune_on_startup":
			return settings.logging.retentionPruneOnStartup;
		case "control.allowed_scopes":
			return settings.control.allowedScopes;
		case "followup.enabled":
			return settings.followup.enabled;
		case "followup.window_seconds":
			return settings.followup.windowSeconds;
		case "followup.max_turns":
			return settings.followup.maxTurns;
		case "followup.stop_phrases":
			return settings.followup.stopPhrases;
		case "ha.enabled":
			return settings.ha.enabled;
		case "ha.timeout_ms":
			return settings.ha.timeoutMs;
		default:
			return "";
	}
}

function toDisplayValue(value: unknown): string {
	if (Array.isArray(value)) return value.join(",");
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	return String(value);
}

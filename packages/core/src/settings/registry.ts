export type SettingScope =
	| "core"
	| "runtime"
	| "control"
	| "stt"
	| "tts"
	| "dialog"
	| "ha"
	| "wakeword"
	| "logging"
	| "tui";
export type SettingMutability = "runtime" | "restart_required";
export type LogLevel = "info" | "warn" | "error";

export type SettingsKey =
	| "runtime.profile"
	| "tui.user_name"
	| "logging.level"
	| "logging.transcript_enabled"
	| "logging.audio_input_enabled"
	| "logging.dialog_enabled"
	| "logging.dialog_markdown_enabled"
	| "logging.perf_enabled"
	| "logging.perf_sample_ms"
	| "logging.retention_enabled"
	| "logging.retention_max_bytes"
	| "logging.retention_max_age_days"
	| "logging.retention_prune_on_startup"
	| "control.allowed_scopes"
	| "followup.enabled"
	| "followup.window_seconds"
	| "followup.max_turns"
	| "followup.stop_phrases"
	| "ha.enabled"
	| "ha.timeout_ms";

interface SettingValueByKey {
	"runtime.profile": "voice" | "text" | "hybrid";
	"tui.user_name": string;
	"logging.level": LogLevel;
	"logging.transcript_enabled": boolean;
	"logging.audio_input_enabled": boolean;
	"logging.dialog_enabled": boolean;
	"logging.dialog_markdown_enabled": boolean;
	"logging.perf_enabled": boolean;
	"logging.perf_sample_ms": number;
	"logging.retention_enabled": boolean;
	"logging.retention_max_bytes": number;
	"logging.retention_max_age_days": number;
	"logging.retention_prune_on_startup": boolean;
	"control.allowed_scopes": string[];
	"followup.enabled": boolean;
	"followup.window_seconds": number;
	"followup.max_turns": number;
	"followup.stop_phrases": string[];
	"ha.enabled": boolean;
	"ha.timeout_ms": number;
}

export interface SettingMeta<K extends SettingsKey = SettingsKey> {
	key: K;
	envName: string;
	defaultValue: SettingValueByKey[K];
	parse: (rawValue: string | undefined, env: NodeJS.ProcessEnv) => SettingValueByKey[K];
	scope: SettingScope;
	sensitive: boolean;
	mutability: SettingMutability;
}

export interface ResolvedSettings {
	runtime: {
		profile: "voice" | "text" | "hybrid";
	};
	tui: {
		userName: string;
	};
	logging: {
		level: LogLevel;
		transcriptEnabled: boolean;
		audioInputEnabled: boolean;
		dialogEnabled: boolean;
		dialogMarkdownEnabled: boolean;
		perfEnabled: boolean;
		perfSampleMs: number;
		retentionEnabled: boolean;
		retentionMaxBytes: number;
		retentionMaxAgeDays: number;
		retentionPruneOnStartup: boolean;
	};
	followup: {
		enabled: boolean;
		windowSeconds: number;
		maxTurns: number;
		stopPhrases: string[];
	};
	control: {
		allowedScopes: string[];
	};
	ha: {
		enabled: boolean;
		timeoutMs: number;
	};
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const EDGE_TRIM_REGEX = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return fallback;
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return fallback;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	if (!/^\d+$/.test(trimmed)) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFiniteNumber(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLogLevel(rawValue: string | undefined, fallback: LogLevel): LogLevel {
	const normalized = rawValue?.trim().toLowerCase();
	if (normalized === "warn") return "warn";
	if (normalized === "error") return "error";
	if (normalized === "info") return "info";
	return fallback;
}

function parseStopPhrases(rawValue: string | undefined): string[] {
	if (!rawValue) return [];
	const unique = new Set<string>();
	for (const token of rawValue.split(",")) {
		const normalized = token.toLocaleLowerCase().replace(EDGE_TRIM_REGEX, "").trim();
		if (!normalized) continue;
		unique.add(normalized);
	}
	return [...unique];
}

function parsePolicyScopes(rawValue: string | undefined): string[] {
	if (!rawValue?.trim()) return ["ha:write"];
	const unique = new Set<string>();
	for (const token of rawValue.split(",")) {
		const normalized = token.trim().toLowerCase();
		if (!normalized) continue;
		unique.add(normalized);
	}
	return unique.size > 0 ? [...unique] : ["ha:write"];
}

function parseRuntimeProfile(rawValue: string | undefined): "voice" | "text" | "hybrid" {
	const normalized = rawValue?.trim().toLowerCase();
	if (normalized === "text") return "text";
	if (normalized === "hybrid") return "hybrid";
	return "voice";
}

function parseUserName(rawValue: string | undefined, fallback: string): string {
	const trimmed = rawValue?.trim();
	return trimmed ? trimmed : fallback;
}

const SETTING_DEFINITIONS: { [K in SettingsKey]: SettingMeta<K> } = {
	"runtime.profile": {
		key: "runtime.profile",
		envName: "HERZEN_RUNTIME_PROFILE",
		defaultValue: "voice",
		parse: (rawValue) => parseRuntimeProfile(rawValue),
		scope: "runtime",
		sensitive: false,
		mutability: "runtime",
	},
	"tui.user_name": {
		key: "tui.user_name",
		envName: "USER_NAME",
		defaultValue: "USER",
		parse: (rawValue) => parseUserName(rawValue, "USER"),
		scope: "tui",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.level": {
		key: "logging.level",
		envName: "HERZEN_LOG_LEVEL",
		defaultValue: "info",
		parse: (rawValue) => parseLogLevel(rawValue, "info"),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.transcript_enabled": {
		key: "logging.transcript_enabled",
		envName: "HERZEN_LOG_TRANSCRIPT",
		defaultValue: false,
		parse: (rawValue) => parseBoolean(rawValue, false),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.audio_input_enabled": {
		key: "logging.audio_input_enabled",
		envName: "HERZEN_LOG_AUDIO_INPUT",
		defaultValue: false,
		parse: (rawValue) => parseBoolean(rawValue, false),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.dialog_enabled": {
		key: "logging.dialog_enabled",
		envName: "HERZEN_LOG_DIALOG",
		defaultValue: true,
		parse: (rawValue) => parseBoolean(rawValue, true),
		scope: "dialog",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.dialog_markdown_enabled": {
		key: "logging.dialog_markdown_enabled",
		envName: "HERZEN_LOG_DIALOG_MARKDOWN",
		defaultValue: true,
		parse: (rawValue) => parseBoolean(rawValue, true),
		scope: "dialog",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.perf_enabled": {
		key: "logging.perf_enabled",
		envName: "HERZEN_LOG_PERF",
		defaultValue: true,
		parse: (rawValue) => parseBoolean(rawValue, true),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.perf_sample_ms": {
		key: "logging.perf_sample_ms",
		envName: "HERZEN_PERF_SAMPLE_MS",
		defaultValue: 1000,
		parse: (rawValue) => parsePositiveInteger(rawValue, 1000),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.retention_enabled": {
		key: "logging.retention_enabled",
		envName: "HERZEN_LOG_RETENTION_ENABLED",
		defaultValue: true,
		parse: (rawValue) => parseBoolean(rawValue, true),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.retention_max_bytes": {
		key: "logging.retention_max_bytes",
		envName: "HERZEN_LOG_RETENTION_MAX_BYTES",
		defaultValue: 50 * 1024 * 1024,
		parse: (rawValue) => parsePositiveInteger(rawValue, 50 * 1024 * 1024),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.retention_max_age_days": {
		key: "logging.retention_max_age_days",
		envName: "HERZEN_LOG_RETENTION_MAX_DAYS",
		defaultValue: 14,
		parse: (rawValue) => parsePositiveInteger(rawValue, 14),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"logging.retention_prune_on_startup": {
		key: "logging.retention_prune_on_startup",
		envName: "HERZEN_LOG_RETENTION_PRUNE_ON_STARTUP",
		defaultValue: true,
		parse: (rawValue) => parseBoolean(rawValue, true),
		scope: "logging",
		sensitive: false,
		mutability: "runtime",
	},
	"control.allowed_scopes": {
		key: "control.allowed_scopes",
		envName: "HERZEN_POLICY_ALLOWED_SCOPES",
		defaultValue: ["ha:write"],
		parse: (rawValue) => parsePolicyScopes(rawValue),
		scope: "control",
		sensitive: false,
		mutability: "runtime",
	},
	"followup.enabled": {
		key: "followup.enabled",
		envName: "HERZEN_FOLLOWUP_ENABLED",
		defaultValue: false,
		parse: (rawValue) => parseBoolean(rawValue, false),
		scope: "core",
		sensitive: false,
		mutability: "runtime",
	},
	"followup.window_seconds": {
		key: "followup.window_seconds",
		envName: "HERZEN_FOLLOWUP_WINDOW_SECONDS",
		defaultValue: 8,
		parse: (rawValue) => parsePositiveFiniteNumber(rawValue, 8),
		scope: "core",
		sensitive: false,
		mutability: "runtime",
	},
	"followup.max_turns": {
		key: "followup.max_turns",
		envName: "HERZEN_FOLLOWUP_MAX_TURNS",
		defaultValue: 3,
		parse: (rawValue) => parsePositiveInteger(rawValue, 3),
		scope: "core",
		sensitive: false,
		mutability: "runtime",
	},
	"followup.stop_phrases": {
		key: "followup.stop_phrases",
		envName: "HERZEN_FOLLOWUP_STOP_PHRASES",
		defaultValue: [],
		parse: (rawValue) => parseStopPhrases(rawValue),
		scope: "core",
		sensitive: false,
		mutability: "runtime",
	},
	"ha.enabled": {
		key: "ha.enabled",
		envName: "HERZEN_HA_ENABLED",
		defaultValue: false,
		parse: (rawValue) => parseBoolean(rawValue, false),
		scope: "ha",
		sensitive: false,
		mutability: "restart_required",
	},
	"ha.timeout_ms": {
		key: "ha.timeout_ms",
		envName: "HERZEN_HA_TIMEOUT_MS",
		defaultValue: 5000,
		parse: (rawValue) => parsePositiveInteger(rawValue, 5000),
		scope: "ha",
		sensitive: false,
		mutability: "runtime",
	},
};

export function getSettingMeta<K extends SettingsKey>(key: K): SettingMeta<K> {
	return SETTING_DEFINITIONS[key];
}

export function listSettingsByScope(scope: SettingScope): SettingMeta[] {
	return Object.values(SETTING_DEFINITIONS).filter((meta) => meta.scope === scope);
}

function resolveValue<K extends SettingsKey>(key: K, env: NodeJS.ProcessEnv): SettingValueByKey[K] {
	const meta = SETTING_DEFINITIONS[key];
	return meta.parse(env[meta.envName], env);
}

export function resolveSettings(env: NodeJS.ProcessEnv = process.env): ResolvedSettings {
	return {
		runtime: {
			profile: resolveValue("runtime.profile", env),
		},
		tui: {
			userName: resolveValue("tui.user_name", env),
		},
		logging: {
			level: resolveValue("logging.level", env),
			transcriptEnabled: resolveValue("logging.transcript_enabled", env),
			audioInputEnabled: resolveValue("logging.audio_input_enabled", env),
			dialogEnabled: resolveValue("logging.dialog_enabled", env),
			dialogMarkdownEnabled: resolveValue("logging.dialog_markdown_enabled", env),
			perfEnabled: resolveValue("logging.perf_enabled", env),
			perfSampleMs: resolveValue("logging.perf_sample_ms", env),
			retentionEnabled: resolveValue("logging.retention_enabled", env),
			retentionMaxBytes: resolveValue("logging.retention_max_bytes", env),
			retentionMaxAgeDays: resolveValue("logging.retention_max_age_days", env),
			retentionPruneOnStartup: resolveValue("logging.retention_prune_on_startup", env),
		},
		followup: {
			enabled: resolveValue("followup.enabled", env),
			windowSeconds: resolveValue("followup.window_seconds", env),
			maxTurns: resolveValue("followup.max_turns", env),
			stopPhrases: resolveValue("followup.stop_phrases", env),
		},
		control: {
			allowedScopes: resolveValue("control.allowed_scopes", env),
		},
		ha: {
			enabled: resolveValue("ha.enabled", env),
			timeoutMs: resolveValue("ha.timeout_ms", env),
		},
	};
}

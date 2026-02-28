import { HomeAssistantError } from "./types.js";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LIGHT_ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/;
const SCENE_ENTITY_ID_PATTERN = /^scene\.[a-z0-9_]+$/;
const HOME_ASSISTANT_SECRETS_DIR_ENV = "HERZEN_HA_SECRETS_DIR";

export interface HomeAssistantConfig {
	enabled: boolean;
	baseUrl: string;
	token: string;
	timeoutMs: number;
	allowedLights: string[];
	aliasToLightEntityIds: Record<string, string[]>;
	aliasToSceneEntityId: Record<string, string>;
	defaultLight?: string;
}

export interface HomeAssistantConfigOverrides {
	enabled?: boolean;
	timeoutMs?: number;
	allowedLights?: string[];
	lightAliases?: string;
	sceneAliases?: string;
	defaultLight?: string;
}

export function resolveHomeAssistantConfig(
	env: NodeJS.ProcessEnv = process.env,
	overrides: HomeAssistantConfigOverrides = {},
): HomeAssistantConfig {
	const enabled = overrides.enabled ?? resolveBooleanFlag(env.HERZEN_HA_ENABLED, false);
	if (!enabled) {
		return {
			enabled: false,
			baseUrl: "",
			token: "",
			timeoutMs: DEFAULT_TIMEOUT_MS,
			allowedLights: [],
			aliasToLightEntityIds: {},
			aliasToSceneEntityId: {},
		};
	}

	const baseUrl = normalizeBaseUrl(
		resolveRequiredValue("HERZEN_HA_BASE_URL", env, {
			secretsDirFileName: "base_url",
		}),
	);
	const token = resolveRequiredValue("HERZEN_HA_TOKEN", env, {
		secretsDirFileName: "token",
		requireStrictFilePermissions: true,
	});

	const timeoutMs =
		typeof overrides.timeoutMs === "number" ?
			resolveExplicitPositiveInteger(overrides.timeoutMs, "timeoutMs")
		: resolvePositiveInteger(env.HERZEN_HA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "HERZEN_HA_TIMEOUT_MS");
	const lightAliasesRaw = overrides.lightAliases ?? env.HERZEN_HA_LIGHT_ALIASES;
	const sceneAliasesRaw = overrides.sceneAliases ?? env.HERZEN_HA_SCENE_ALIASES;
	const aliasToLightEntityIds = parseLightAliases(lightAliasesRaw);
	const aliasToSceneEntityId = parseSceneAliases(sceneAliasesRaw);
	const explicitAllowed =
		overrides.allowedLights ? parseAllowedLightsOverride(overrides.allowedLights) : parseEntityList(env.HERZEN_HA_ALLOWED_LIGHTS, "HERZEN_HA_ALLOWED_LIGHTS");

	let allowedLights = explicitAllowed;
	if (allowedLights.length === 0) {
		allowedLights = uniqueValues(
			Object.values(aliasToLightEntityIds).flatMap((entityIds) => entityIds),
		);
	}

	const defaultLightRaw = overrides.defaultLight?.trim().toLowerCase() ?? env.HERZEN_HA_DEFAULT_LIGHT?.trim().toLowerCase();
	let defaultLight: string | undefined;
	if (defaultLightRaw) {
		assertLightEntityId(defaultLightRaw, "HERZEN_HA_DEFAULT_LIGHT");
		defaultLight = defaultLightRaw;
		if (!allowedLights.includes(defaultLight)) {
			allowedLights = [...allowedLights, defaultLight];
		}
	}

	if (allowedLights.length === 0) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			"At least one light must be configured. Set HERZEN_HA_ALLOWED_LIGHTS, HERZEN_HA_LIGHT_ALIASES, or HERZEN_HA_DEFAULT_LIGHT.",
		);
	}

	for (const [alias, entityIds] of Object.entries(aliasToLightEntityIds)) {
		for (const entityId of entityIds) {
			if (allowedLights.includes(entityId)) continue;
			throw new HomeAssistantError(
				"CONFIG_INVALID",
				`Alias "${alias}" points to non-allowlisted entity "${entityId}".`,
			);
		}
	}

	return {
		enabled,
		baseUrl,
		token,
		timeoutMs,
		allowedLights,
		aliasToLightEntityIds,
		aliasToSceneEntityId,
		defaultLight,
	};
}

export function normalizeAlias(rawAlias: string): string {
	return rawAlias.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeMatchText(rawText: string): string {
	return rawText
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}_]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function resolveBooleanFlag(rawValue: string | undefined, fallback: boolean): boolean {
	const normalized = rawValue?.trim().toLowerCase();
	if (!normalized) return fallback;
	if (TRUE_VALUES.has(normalized)) return true;
	return false;
}

interface ResolveRequiredValueOptions {
	secretsDirFileName: string;
	requireStrictFilePermissions?: boolean;
}

function resolveRequiredValue(
	envName: string,
	env: NodeJS.ProcessEnv,
	options: ResolveRequiredValueOptions,
): string {
	const inlineValue = env[envName]?.trim();
	if (inlineValue) {
		return inlineValue;
	}

	const explicitFilePath = env[`${envName}_FILE`]?.trim();
	if (explicitFilePath) {
		return readRequiredValueFromFile(
			envName,
			resolveMaybeRelativePath(explicitFilePath, env),
			options.requireStrictFilePermissions,
		);
	}

	const secretsDir = env[HOME_ASSISTANT_SECRETS_DIR_ENV]?.trim();
	if (secretsDir) {
		const candidatePath = join(resolveMaybeRelativePath(secretsDir, env), options.secretsDirFileName);
		return readRequiredValueFromFile(envName, candidatePath, options.requireStrictFilePermissions);
	}

	throw new HomeAssistantError(
		"CONFIG_INVALID",
		`${envName} is required when HERZEN_HA_ENABLED=1. Set ${envName}, ${envName}_FILE, or ${HOME_ASSISTANT_SECRETS_DIR_ENV}.`,
	);
}

function resolveMaybeRelativePath(rawPath: string, env: NodeJS.ProcessEnv): string {
	if (isAbsolute(rawPath)) {
		return rawPath;
	}
	const herzenRoot = env.HERZEN_ROOT?.trim();
	if (herzenRoot) {
		return join(herzenRoot, rawPath);
	}
	return rawPath;
}

function readRequiredValueFromFile(
	envName: string,
	filePathRaw: string,
	requireStrictPermissions = false,
): string {
	const filePath = filePathRaw.trim();
	if (!filePath) {
		throw new HomeAssistantError("CONFIG_INVALID", `${envName}_FILE must not be empty.`);
	}

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(filePath);
	} catch (err) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			`Could not read ${envName}_FILE at "${filePath}".`,
			{ cause: err },
		);
	}

	if (!stats.isFile()) {
		throw new HomeAssistantError("CONFIG_INVALID", `${envName}_FILE path "${filePath}" is not a file.`);
	}

	if (requireStrictPermissions) {
		assertStrictPrivatePermissions(envName, filePath, stats.mode);
	}

	let fileValue: string;
	try {
		fileValue = readFileSync(filePath, "utf8");
	} catch (err) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			`Failed reading ${envName}_FILE at "${filePath}".`,
			{ cause: err },
		);
	}

	const trimmed = fileValue.trim();
	if (!trimmed) {
		throw new HomeAssistantError("CONFIG_INVALID", `${envName}_FILE at "${filePath}" is empty.`);
	}
	return trimmed;
}

function assertStrictPrivatePermissions(envName: string, filePath: string, mode: number): void {
	if (process.platform === "win32") return;
	if ((mode & 0o077) === 0) return;
	throw new HomeAssistantError(
		"CONFIG_INVALID",
		`${envName}_FILE at "${filePath}" must be owner-only (chmod 600).`,
	);
}

function normalizeBaseUrl(rawValue: string | undefined): string {
	const trimmed = rawValue?.trim();
	if (!trimmed) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			"HERZEN_HA_BASE_URL is required when HERZEN_HA_ENABLED=1.",
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch (err) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			`Invalid HERZEN_HA_BASE_URL "${trimmed}". Expected a valid http(s) URL.`,
			{ cause: err },
		);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			`Unsupported HERZEN_HA_BASE_URL protocol "${parsed.protocol}". Expected http or https.`,
		);
	}

	return parsed.toString().replace(/\/$/, "");
}

function resolvePositiveInteger(rawValue: string | undefined, fallback: number, envName: string): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	if (!/^\d+$/.test(trimmed)) {
		throw new HomeAssistantError("CONFIG_INVALID", `${envName} must be a positive integer.`);
	}
	const parsed = Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new HomeAssistantError("CONFIG_INVALID", `${envName} must be a positive integer.`);
	}
	return parsed;
}

function parseEntityList(rawValue: string | undefined, envName: string): string[] {
	if (!rawValue?.trim()) return [];
	const entities: string[] = [];
	for (const token of rawValue.split(",")) {
		const entityId = token.trim().toLowerCase();
		if (!entityId) continue;
		assertLightEntityId(entityId, envName);
		entities.push(entityId);
	}
	return uniqueValues(entities);
}

function parseAllowedLightsOverride(allowedLights: string[]): string[] {
	const entities: string[] = [];
	for (const value of allowedLights) {
		const entityId = value.trim().toLowerCase();
		if (!entityId) continue;
		assertLightEntityId(entityId, "allowedLights");
		entities.push(entityId);
	}
	return uniqueValues(entities);
}

function parseLightAliases(rawValue: string | undefined): Record<string, string[]> {
	if (!rawValue?.trim()) return {};
	const aliases: Record<string, string[]> = {};

	for (const pair of rawValue.split(",")) {
		const [rawAlias, rawEntityId, ...rest] = pair.split("=");
		if (rest.length > 0 || !rawAlias || !rawEntityId) {
			throw new HomeAssistantError(
				"CONFIG_INVALID",
				`Invalid HERZEN_HA_LIGHT_ALIASES entry "${pair.trim()}". Expected alias=light.entity_id format.`,
			);
		}
		const alias = normalizeAlias(rawAlias);
		const entityIds = parseMultiLightEntityId(rawEntityId, "HERZEN_HA_LIGHT_ALIASES");
		if (!alias) {
			throw new HomeAssistantError("CONFIG_INVALID", "HERZEN_HA_LIGHT_ALIASES alias must not be empty.");
		}
		aliases[alias] = entityIds;
	}

	return aliases;
}

function parseSceneAliases(rawValue: string | undefined): Record<string, string> {
	if (!rawValue?.trim()) return {};
	const aliases: Record<string, string> = {};

	for (const pair of rawValue.split(",")) {
		const [rawAlias, rawEntityId, ...rest] = pair.split("=");
		if (rest.length > 0 || !rawAlias || !rawEntityId) {
			throw new HomeAssistantError(
				"CONFIG_INVALID",
				`Invalid HERZEN_HA_SCENE_ALIASES entry "${pair.trim()}". Expected alias=scene.entity_id format.`,
			);
		}
		const alias = normalizeAlias(rawAlias);
		const entityId = rawEntityId.trim().toLowerCase();
		if (!alias) {
			throw new HomeAssistantError("CONFIG_INVALID", "HERZEN_HA_SCENE_ALIASES alias must not be empty.");
		}
		assertSceneEntityId(entityId, "HERZEN_HA_SCENE_ALIASES");
		aliases[alias] = entityId;
	}

	return aliases;
}

function parseMultiLightEntityId(rawValue: string, envName: string): string[] {
	const tokens = rawValue
		.split("|")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (tokens.length === 0) {
		throw new HomeAssistantError("CONFIG_INVALID", `${envName} must not contain empty entity ids.`);
	}
	const unique = uniqueValues(tokens);
	for (const entityId of unique) {
		assertLightEntityId(entityId, envName);
	}
	return unique;
}

function assertLightEntityId(entityId: string, envName: string): void {
	if (!LIGHT_ENTITY_ID_PATTERN.test(entityId)) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			`${envName} contains invalid light entity id "${entityId}". Expected format light.entity_name`,
		);
	}
}

function assertSceneEntityId(entityId: string, envName: string): void {
	if (!SCENE_ENTITY_ID_PATTERN.test(entityId)) {
		throw new HomeAssistantError(
			"CONFIG_INVALID",
			`${envName} contains invalid scene entity id "${entityId}". Expected format scene.entity_name`,
		);
	}
}

function uniqueValues(values: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		unique.push(value);
	}
	return unique;
}

function resolveExplicitPositiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new HomeAssistantError("CONFIG_INVALID", `${name} must be a positive integer.`);
	}
	return value;
}

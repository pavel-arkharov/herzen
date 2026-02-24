import {
	normalizeAlias,
	normalizeMatchText,
	resolveHomeAssistantConfig,
	type HomeAssistantConfig,
} from "./config.js";
import {
	HomeAssistantError,
	type HomeAssistantHandledAction,
	type HomeAssistantService,
	type HomeIntent,
	type LightOperation,
	type SceneIntent,
} from "./types.js";

interface CreateHomeAssistantServiceOptions {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

interface ServiceResponse {
	ok: boolean;
	statusCode?: number;
	message?: string;
	code?: string;
}

interface HomeAction {
	operation: "light.turn_on" | "light.turn_off" | "scene.turn_on";
	entityId: string;
	targetLabel: string;
	payload: {
		entity_id: string | string[];
	};
}

const ON_PHRASES = ["turn on", "switch on", "light on", "lights on", "включи", "включить", "вруби", "зажги"];
const OFF_PHRASES = [
	"turn off",
	"switch off",
	"light off",
	"lights off",
	"выключи",
	"выключить",
	"погаси",
];

export function createHomeAssistantService(
	options: CreateHomeAssistantServiceOptions = {},
): HomeAssistantService {
	const config = resolveHomeAssistantConfig(options.env ?? process.env);
	const fetchImpl = options.fetchImpl ?? fetch;
	const allowedSet = new Set(config.allowedLights);

	return {
		enabled: config.enabled,
		handleTranscript: async (transcript: string): Promise<HomeAssistantHandledAction | null> => {
			if (!config.enabled) return null;

			const intent = resolveHomeIntent(transcript, config, allowedSet);
			if (!intent) return null;

			const language = detectLanguage(transcript);
			if (intent.kind === "light" && intent.entityIds.length === 0) {
				return buildUnresolvedLight(language, intent.matchedAlias);
			}

			const action = mapIntentToAction(intent);
			const startedAt = Date.now();
			const serviceResponse = await callHomeAssistantService(fetchImpl, config, action);
			const durationMs = Date.now() - startedAt;

			return {
				integration: "home_assistant",
				operation: action.operation,
				entityId: action.entityId,
				matchedAlias: intent.matchedAlias,
				assistantText: buildAssistantText(action, serviceResponse, language),
				language,
				durationMs,
				args: action.payload,
				result: serviceResponse,
			};
		},
	};
}

export function resolveHomeIntent(
	transcript: string,
	config: HomeAssistantConfig,
	allowedSet = new Set(config.allowedLights),
): HomeIntent | null {
	if (!config.enabled) return null;
	const normalized = normalizeMatchText(transcript);
	if (!normalized) return null;

	const sceneIntent = resolveSceneIntent(normalized, config.aliasToSceneEntityId);
	if (sceneIntent) return sceneIntent;

	const operation = detectLightOperation(normalized);
	if (!operation) return null;

	const aliasMatch = findAliasMatch(normalized, config.aliasToLightEntityIds);
	if (aliasMatch) {
		const entityIds = config.aliasToLightEntityIds[aliasMatch] ?? [];
		const allowlisted = entityIds.filter((entityId) => allowedSet.has(entityId));
		return {
			kind: "light",
			operation,
			entityIds: allowlisted,
			matchedAlias: aliasMatch,
		};
	}

	const directEntityIds = findDirectEntityIds(transcript.toLocaleLowerCase(), allowedSet);
	if (directEntityIds.length > 0) {
		return {
			kind: "light",
			operation,
			entityIds: directEntityIds,
		};
	}

	const fallbackEntityIds = resolveFallbackLightEntityIds(config);
	return {
		kind: "light",
		operation,
		entityIds: fallbackEntityIds,
	};
}

function resolveSceneIntent(text: string, aliasToSceneEntityId: Record<string, string>): SceneIntent | null {
	const alias = findAliasMatch(text, aliasToSceneEntityId);
	if (!alias) return null;
	const sceneId = aliasToSceneEntityId[alias];
	if (!sceneId) return null;
	return {
		kind: "scene",
		sceneId,
		matchedAlias: alias,
	};
}

function mapIntentToAction(intent: HomeIntent): HomeAction {
	if (intent.kind === "scene") {
		return {
			operation: "scene.turn_on",
			entityId: intent.sceneId,
			targetLabel: intent.matchedAlias ?? intent.sceneId,
			payload: {
				entity_id: intent.sceneId,
			},
		};
	}

	const entityId = intent.entityIds[0] ?? "";
	const entityPayload = intent.entityIds.length === 1 ? entityId : intent.entityIds;
	return {
		operation: intent.operation === "turn_on" ? "light.turn_on" : "light.turn_off",
		entityId,
		targetLabel: intent.matchedAlias ?? humanLightTarget(intent.entityIds),
		payload: {
			entity_id: entityPayload,
		},
	};
}

function resolveFallbackLightEntityIds(config: HomeAssistantConfig): string[] {
	if (config.defaultLight) return [config.defaultLight];
	if (config.allowedLights.length === 1) return [config.allowedLights[0] ?? ""].filter(Boolean);
	return [];
}

function detectLightOperation(text: string): LightOperation | null {
	for (const phrase of OFF_PHRASES) {
		if (containsPhrase(text, phrase)) return "turn_off";
	}
	for (const phrase of ON_PHRASES) {
		if (containsPhrase(text, phrase)) return "turn_on";
	}
	return null;
}

function findAliasMatch<T>(text: string, aliases: Record<string, T>): string | null {
	const entries = Object.keys(aliases).sort((left, right) => right.length - left.length);
	for (const alias of entries) {
		const normalizedAlias = normalizeAlias(alias);
		if (!normalizedAlias) continue;
		const boundaryPattern = new RegExp(`(?:^|\\s)${escapeRegExp(normalizedAlias)}(?:$|\\s)`, "u");
		if (boundaryPattern.test(text)) return normalizedAlias;
	}
	return null;
}

function findDirectEntityIds(text: string, allowedSet: Set<string>): string[] {
	const matches = text.match(/\blight\.[a-z0-9_]+\b/gu) ?? [];
	const seen = new Set<string>();
	const entityIds: string[] = [];
	for (const match of matches) {
		if (!allowedSet.has(match) || seen.has(match)) continue;
		seen.add(match);
		entityIds.push(match);
	}
	return entityIds;
}

async function callHomeAssistantService(
	fetchImpl: typeof fetch,
	config: HomeAssistantConfig,
	action: HomeAction,
): Promise<ServiceResponse> {
	const [domain, service] = action.operation.split(".");
	const url = `${config.baseUrl}/api/services/${domain}/${service}`;

	let response: Response;
	try {
		response = await fetchWithTimeout(
			fetchImpl,
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.token}`,
				},
				body: JSON.stringify(action.payload),
			},
			config.timeoutMs,
		);
	} catch (err) {
		const message = err instanceof HomeAssistantError ? err.message : errorMessage(err);
		return {
			ok: false,
			code: "REQUEST_FAILED",
			message,
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			statusCode: response.status,
			code: "REQUEST_FAILED",
			message: await readErrorBody(response),
		};
	}

	return {
		ok: true,
		statusCode: response.status,
	};
}

async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		return await fetchImpl(url, {
			...init,
			signal: controller.signal,
		});
	} catch (err) {
		if (isAbortError(err)) {
			throw new HomeAssistantError(
				"RUNTIME_UNAVAILABLE",
				`Timed out while contacting Home Assistant after ${timeoutMs}ms.`,
				{ cause: err },
			);
		}
		throw new HomeAssistantError("REQUEST_FAILED", "Failed to contact Home Assistant.", {
			cause: err,
		});
	} finally {
		clearTimeout(timer);
	}
}

function buildUnresolvedLight(language: "en" | "ru", matchedAlias?: string): HomeAssistantHandledAction {
	return {
		integration: "home_assistant",
		operation: "light.turn_on",
		entityId: "",
		matchedAlias,
		assistantText:
			language === "ru"
				? "[ru] Не понял, какой именно свет переключить. Назовите комнату или устройство."
				: "[en] I need a specific light name. Please say the room or device.",
		language,
		durationMs: 0,
		args: {},
		result: {
			ok: false,
			code: "ENTITY_UNRESOLVED",
			message: "Could not resolve a single allowlisted light entity.",
		},
	};
}

async function readErrorBody(response: Response): Promise<string> {
	try {
		const body = await response.text();
		const normalized = body.replace(/\s+/g, " ").trim();
		if (normalized) {
			return `Home Assistant request failed (HTTP ${response.status}): ${normalized}`;
		}
	} catch {
		return `Home Assistant request failed (HTTP ${response.status}).`;
	}
	return `Home Assistant request failed (HTTP ${response.status}).`;
}

function buildAssistantText(
	action: HomeAction,
	result: ServiceResponse,
	language: "en" | "ru",
): string {
	if (result.ok) {
		if (action.operation === "scene.turn_on") {
			return language === "ru"
				? `[ru] Готово. Активировал сцену: ${action.targetLabel}.`
				: `[en] Done. Activated scene: ${action.targetLabel}.`;
		}

		if (language === "ru") {
			return action.operation === "light.turn_on"
				? `[ru] Готово. Включил свет: ${action.targetLabel}.`
				: `[ru] Готово. Выключил свет: ${action.targetLabel}.`;
		}
		return action.operation === "light.turn_on"
			? `[en] Done. Turned on light: ${action.targetLabel}.`
			: `[en] Done. Turned off light: ${action.targetLabel}.`;
	}

	if (language === "ru") {
		return `[ru] Не получилось выполнить действие (${result.code ?? "error"}).`;
	}
	return `[en] I couldn't complete that action (${result.code ?? "error"}).`;
}

function humanLightTarget(entityIds: string[]): string {
	if (entityIds.length === 0) return "unresolved";
	if (entityIds.length === 1) return entityIds[0] ?? "light";
	return `${entityIds.length} lights`;
}

function detectLanguage(text: string): "en" | "ru" {
	return /[А-Яа-яЁё]/u.test(text) ? "ru" : "en";
}

function isAbortError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "name" in err && (err as { name: unknown }).name === "AbortError";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(text: string, phrase: string): boolean {
	const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(phrase)}(?:$|\\s)`, "u");
	return pattern.test(text);
}

function errorMessage(err: unknown): string {
	if (err instanceof Error && err.message.trim()) return err.message;
	return String(err);
}

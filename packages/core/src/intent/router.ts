import {
	resolveHomeIntent,
	type HomeAssistantConfig,
	type HomeIntent,
} from "@herzen/integration-homeassistant";

export interface DeterministicRouterInput {
	transcript: string;
	detectedLanguage?: string;
	sessionId: string;
	laneKey: string;
	turn?: number;
}

export interface DeterministicCommandCandidate {
	name: "homeassistant.light.turn_on" | "homeassistant.light.turn_off" | "homeassistant.scene.turn_on";
	args: Record<string, unknown>;
	policyScope: "ha:write";
}

export type DeterministicRouteDecision =
	| {
			kind: "execute";
			confidence: number;
			intentName: string;
			command: DeterministicCommandCandidate;
			entities?: Record<string, unknown>;
	  }
	| {
			kind: "clarify";
			confidence: number;
			intentName?: string;
			prompt: string;
			missingFields: string[];
	  }
	| {
			kind: "respond";
			confidence: number;
			reason: string;
	  }
	| {
			kind: "reject";
			confidence: number;
			code: "POLICY_REJECTED";
			reason: string;
	  };

export interface DeterministicIntentRouter {
	route: (input: DeterministicRouterInput) => DeterministicRouteDecision;
}

export interface CreateDeterministicIntentRouterOptions {
	homeAssistantConfig?: HomeAssistantConfig | null;
}

const REJECT_PATTERNS = [
	/\brm\s+-rf\b/u,
	/\bformat\s+disk\b/u,
	/\bdelete\s+all\s+files\b/u,
];

export function createDeterministicIntentRouter(
	options: CreateDeterministicIntentRouterOptions = {},
): DeterministicIntentRouter {
	return {
		route: (input) => {
			const transcript = input.transcript.trim();
			if (!transcript) {
				return {
					kind: "reject",
					confidence: 1,
					code: "POLICY_REJECTED",
					reason: "Empty transcript.",
				};
			}

			if (isPolicyRejected(transcript)) {
				return {
					kind: "reject",
					confidence: 1,
					code: "POLICY_REJECTED",
					reason: "Transcript matched protected policy patterns.",
				};
			}

			const haConfig = options.homeAssistantConfig;
			if (!haConfig?.enabled) {
				return {
					kind: "respond",
					confidence: 0.4,
					reason: "No deterministic command route matched.",
				};
			}

			const intent = resolveHomeIntent(transcript, haConfig);
			if (!intent) {
				return {
					kind: "respond",
					confidence: 0.4,
					reason: "No deterministic command route matched.",
				};
			}

			return resolveIntentDecision(intent, transcript, input.detectedLanguage);
		},
	};
}

function resolveIntentDecision(
	intent: HomeIntent,
	transcript: string,
	detectedLanguage: string | undefined,
): DeterministicRouteDecision {
	if (intent.kind === "light" && intent.entityIds.length === 0) {
		return {
			kind: "clarify",
			confidence: 0.7,
			intentName: "homeassistant.light",
			prompt: isRussian(transcript, detectedLanguage)
				? "[ru] Уточните, какой именно свет включить или выключить."
				: "[en] Which light should I control?",
			missingFields: ["entity_id"],
		};
	}

	if (intent.kind === "scene") {
		const sceneId = intent.sceneId;
		return {
			kind: "execute",
			confidence: 1,
			intentName: "homeassistant.scene.turn_on",
			command: {
				name: "homeassistant.scene.turn_on",
				args: {
					entity_id: sceneId,
				},
				policyScope: "ha:write",
			},
			entities: {
				sceneId,
				matchedAlias: intent.matchedAlias,
			},
		};
	}

	const entityIds = intent.entityIds;
	const commandName =
		intent.operation === "turn_on" ? "homeassistant.light.turn_on" : "homeassistant.light.turn_off";
	return {
		kind: "execute",
		confidence: 1,
		intentName: commandName,
		command: {
			name: commandName,
			args: {
				entity_id: entityIds.length === 1 ? entityIds[0] : entityIds,
			},
			policyScope: "ha:write",
		},
		entities: {
			entityIds,
			matchedAlias: intent.matchedAlias,
		},
	};
}

function isPolicyRejected(transcript: string): boolean {
	const normalized = transcript.toLowerCase();
	return REJECT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isRussian(transcript: string, detectedLanguage: string | undefined): boolean {
	if (detectedLanguage?.toLowerCase().startsWith("ru")) return true;
	return /[А-Яа-яЁё]/u.test(transcript);
}

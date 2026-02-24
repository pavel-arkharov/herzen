export type HomeAssistantErrorCode =
	| "CONFIG_INVALID"
	| "RUNTIME_UNAVAILABLE"
	| "REQUEST_FAILED"
	| "RESPONSE_INVALID";

interface HomeAssistantErrorOptions {
	cause?: unknown;
}

export class HomeAssistantError extends Error {
	readonly code: HomeAssistantErrorCode;
	declare readonly cause?: unknown;

	constructor(code: HomeAssistantErrorCode, message: string, options: HomeAssistantErrorOptions = {}) {
		super(message);
		this.name = "HomeAssistantError";
		this.code = code;
		this.cause = options.cause;
	}
}

export type LightOperation = "turn_on" | "turn_off";

export interface LightIntent {
	kind: "light";
	operation: LightOperation;
	entityIds: string[];
	matchedAlias?: string;
}

export interface SceneIntent {
	kind: "scene";
	sceneId: string;
	matchedAlias?: string;
}

export type HomeIntent = LightIntent | SceneIntent;

export interface HomeAssistantActionResult {
	ok: boolean;
	statusCode?: number;
	message?: string;
	code?: string;
}

export interface HomeAssistantHandledAction {
	integration: "home_assistant";
	operation: "light.turn_on" | "light.turn_off" | "scene.turn_on";
	entityId: string;
	matchedAlias?: string;
	assistantText: string;
	language: "en" | "ru";
	durationMs: number;
	args: {
		entity_id?: string | string[];
	};
	result: HomeAssistantActionResult;
}

export interface HomeAssistantService {
	readonly enabled: boolean;
	handleTranscript: (transcript: string) => Promise<HomeAssistantHandledAction | null>;
}

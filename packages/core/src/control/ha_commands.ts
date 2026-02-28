import type {
	HomeAssistantCommandExecutionResult,
	HomeAssistantCommandName,
	HomeAssistantService,
} from "@herzen/integration-homeassistant";
import type { CommandRegistry, CommandValidationResult } from "./command_registry.js";

const LIGHT_ENTITY_ID_PATTERN = /^light\.[a-z0-9_]+$/u;
const SCENE_ENTITY_ID_PATTERN = /^scene\.[a-z0-9_]+$/u;

interface EntityIdArgs {
	entity_id: string | string[];
}

export function registerHomeAssistantCommands(
	registry: CommandRegistry,
	options: {
		service: HomeAssistantService;
		allowedLights: string[];
	},
): void {
	const allowedLights = new Set(options.allowedLights);

	registry.register({
		name: "homeassistant.light.turn_on",
		policyScope: "ha:write",
		validateArgs: (args) => validateLightArgs(args, allowedLights),
		execute: async (args, context) => executeHomeAssistantCommand(options.service, "homeassistant.light.turn_on", args, context.languageHint),
	});

	registry.register({
		name: "homeassistant.light.turn_off",
		policyScope: "ha:write",
		validateArgs: (args) => validateLightArgs(args, allowedLights),
		execute: async (args, context) => executeHomeAssistantCommand(options.service, "homeassistant.light.turn_off", args, context.languageHint),
	});

	registry.register({
		name: "homeassistant.scene.turn_on",
		policyScope: "ha:write",
		validateArgs: validateSceneArgs,
		execute: async (args, context) => executeHomeAssistantCommand(options.service, "homeassistant.scene.turn_on", args, context.languageHint),
	});
}

function validateLightArgs(
	args: Record<string, unknown>,
	allowedLights: Set<string>,
): CommandValidationResult<EntityIdArgs> {
	const entityIds = normalizeEntityIds(args.entity_id);
	if (!entityIds) {
		return {
			ok: false,
			code: "SCHEMA_INVALID",
			message: "Expected light command args.entity_id as string or non-empty string array.",
		};
	}

	for (const entityId of entityIds) {
		if (!LIGHT_ENTITY_ID_PATTERN.test(entityId)) {
			return {
				ok: false,
				code: "SCHEMA_INVALID",
				message: `Invalid light entity_id "${entityId}".`,
			};
		}
		if (allowedLights.size > 0 && !allowedLights.has(entityId)) {
			return {
				ok: false,
				code: "ENTITY_NOT_ALLOWLISTED",
				message: `Entity "${entityId}" is not allowlisted.`,
			};
		}
	}

	return {
		ok: true,
		args: {
			entity_id: entityIds.length === 1 ? entityIds[0] : entityIds,
		},
	};
}

function validateSceneArgs(args: Record<string, unknown>): CommandValidationResult<EntityIdArgs> {
	const entityId = typeof args.entity_id === "string" ? args.entity_id.trim().toLowerCase() : "";
	if (!entityId || !SCENE_ENTITY_ID_PATTERN.test(entityId)) {
		return {
			ok: false,
			code: "SCHEMA_INVALID",
			message: "Expected scene command args.entity_id as scene.<name>.",
		};
	}
	return {
		ok: true,
		args: {
			entity_id: entityId,
		},
	};
}

function normalizeEntityIds(rawEntityId: unknown): string[] | null {
	if (typeof rawEntityId === "string") {
		const normalized = rawEntityId.trim().toLowerCase();
		return normalized ? [normalized] : null;
	}

	if (Array.isArray(rawEntityId)) {
		const normalized: string[] = [];
		for (const item of rawEntityId) {
			if (typeof item !== "string") return null;
			const value = item.trim().toLowerCase();
			if (!value) return null;
			normalized.push(value);
		}
		return normalized.length > 0 ? [...new Set(normalized)] : null;
	}

	return null;
}

async function executeHomeAssistantCommand(
	service: HomeAssistantService,
	name: HomeAssistantCommandName,
	args: EntityIdArgs,
	languageHint: string | undefined,
): Promise<
	| {
			ok: true;
			result: HomeAssistantCommandExecutionResult;
	  }
	| {
			ok: false;
			code: string;
			message: string;
			details?: Record<string, unknown>;
	  }
> {
	const result = await service.executeCommand({
		name,
		args,
		languageHint,
	});

	if (result.result.ok) {
		return {
			ok: true,
			result,
		};
	}

	return {
		ok: false,
		code: result.result.code ?? "REQUEST_FAILED",
		message: result.result.message ?? "Home Assistant command failed.",
		details: {
			statusCode: result.result.statusCode,
			assistantText: result.assistantText,
			language: result.language,
			operation: result.operation,
		},
	};
}

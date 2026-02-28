import { describe, expect, it, vi } from "vitest";
import type {
	HomeAssistantCommandExecutionResult,
	HomeAssistantService,
} from "@herzen/integration-homeassistant";
import { createCommandRegistry } from "../src/control/command_registry.js";
import { registerHomeAssistantCommands } from "../src/control/ha_commands.js";
import { createPolicyGate } from "../src/control/policy_gate.js";

function createHomeAssistantServiceMock(
	result: HomeAssistantCommandExecutionResult,
): {
	service: HomeAssistantService;
	executeCommand: ReturnType<typeof vi.fn>;
} {
	const executeCommand = vi.fn(async () => result);
	return {
		service: {
			enabled: true,
			executeCommand,
			handleTranscript: vi.fn(async () => null),
		},
		executeCommand,
	};
}

const successResult: HomeAssistantCommandExecutionResult = {
	integration: "home_assistant",
	operation: "light.turn_on",
	entityId: "light.kitchen",
	assistantText: "[en] Done. Turned on light: kitchen.",
	language: "en",
	durationMs: 42,
	args: {
		entity_id: "light.kitchen",
	},
	result: {
		ok: true,
		statusCode: 200,
	},
};

describe("command registry (ha commands)", () => {
	it("executes a valid command after validation + policy pass", async () => {
		const { service, executeCommand } = createHomeAssistantServiceMock(successResult);
		const registry = createCommandRegistry({
			policyGate: createPolicyGate({ allowedScopes: ["ha:write"] }),
		});
		registerHomeAssistantCommands(registry, {
			service,
			allowedLights: ["light.kitchen"],
		});

		const result = await registry.execute(
			{
				name: "homeassistant.light.turn_on",
				args: { entity_id: "light.kitchen" },
				policyScope: "ha:write",
				idempotencyKey: "cmd-1",
			},
			{
				sessionId: "session-1",
				turn: 1,
				laneKey: "session:session-1:trigger",
				traceId: "trace-1",
				languageHint: "en",
			},
		);

		expect(result).toMatchObject({
			ok: true,
			name: "homeassistant.light.turn_on",
		});
		expect(executeCommand).toHaveBeenCalledWith({
			name: "homeassistant.light.turn_on",
			args: { entity_id: "light.kitchen" },
			languageHint: "en",
		});
	});

	it("fails validation and blocks side effects on invalid args", async () => {
		const { service, executeCommand } = createHomeAssistantServiceMock(successResult);
		const registry = createCommandRegistry({
			policyGate: createPolicyGate({ allowedScopes: ["ha:write"] }),
		});
		registerHomeAssistantCommands(registry, {
			service,
			allowedLights: ["light.kitchen"],
		});

		const result = await registry.execute(
			{
				name: "homeassistant.light.turn_on",
				args: { entity_id: "scene.movie_time" },
				policyScope: "ha:write",
				idempotencyKey: "cmd-2",
			},
			{
				sessionId: "session-1",
				turn: 2,
				laneKey: "session:session-1:trigger",
			},
		);

		expect(result).toMatchObject({
			ok: false,
			phase: "validation",
			code: "SCHEMA_INVALID",
		});
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("fails policy gate and blocks side effects for disallowed scope", async () => {
		const { service, executeCommand } = createHomeAssistantServiceMock(successResult);
		const registry = createCommandRegistry({
			policyGate: createPolicyGate({ allowedScopes: [] }),
		});
		registerHomeAssistantCommands(registry, {
			service,
			allowedLights: ["light.kitchen"],
		});

		const result = await registry.execute(
			{
				name: "homeassistant.light.turn_on",
				args: { entity_id: "light.kitchen" },
				policyScope: "ha:write",
				idempotencyKey: "cmd-3",
			},
			{
				sessionId: "session-1",
				turn: 3,
				laneKey: "session:session-1:trigger",
			},
		);

		expect(result).toMatchObject({
			ok: false,
			phase: "policy",
			code: "POLICY_SCOPE_DENIED",
		});
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("reports execution failure from adapter", async () => {
		const { service } = createHomeAssistantServiceMock({
			...successResult,
			result: {
				ok: false,
				code: "REQUEST_FAILED",
				message: "Forbidden",
				statusCode: 403,
			},
			assistantText: "[en] I couldn't complete that action (REQUEST_FAILED).",
		});
		const registry = createCommandRegistry({
			policyGate: createPolicyGate({ allowedScopes: ["ha:write"] }),
		});
		registerHomeAssistantCommands(registry, {
			service,
			allowedLights: ["light.kitchen"],
		});

		const result = await registry.execute(
			{
				name: "homeassistant.light.turn_on",
				args: { entity_id: "light.kitchen" },
				policyScope: "ha:write",
				idempotencyKey: "cmd-4",
			},
			{
				sessionId: "session-1",
				turn: 4,
				laneKey: "session:session-1:trigger",
			},
		);

		expect(result).toMatchObject({
			ok: false,
			phase: "execution",
			code: "REQUEST_FAILED",
		});
	});
});

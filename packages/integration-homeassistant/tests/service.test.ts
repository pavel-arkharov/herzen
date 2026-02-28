import { describe, expect, it, vi } from "vitest";
import { createHomeAssistantService, resolveHomeIntent } from "../src/service.js";
import { resolveHomeAssistantConfig } from "../src/config.js";

const enabledEnv: NodeJS.ProcessEnv = {
	HERZEN_HA_ENABLED: "1",
	HERZEN_HA_BASE_URL: "http://homeassistant.local:8123",
	HERZEN_HA_TOKEN: "token",
	HERZEN_HA_ALLOWED_LIGHTS: "light.kitchen_main,light.kitchen_accent,light.living_room",
	HERZEN_HA_LIGHT_ALIASES:
		"kitchen=light.kitchen_main|light.kitchen_accent,living room=light.living_room,кухня=light.kitchen_main|light.kitchen_accent",
	HERZEN_HA_SCENE_ALIASES: "bedroom reading=scene.bedroom_reading,movie time=scene.movie_time",
};

describe("resolveHomeIntent", () => {
	it("matches english off command by multi-light alias", () => {
		const config = resolveHomeAssistantConfig(enabledEnv);
		expect(resolveHomeIntent("turn off kitchen lights", config)).toEqual({
			kind: "light",
			operation: "turn_off",
			entityIds: ["light.kitchen_main", "light.kitchen_accent"],
			matchedAlias: "kitchen",
		});
	});

	it("matches russian on command by alias", () => {
		const config = resolveHomeAssistantConfig(enabledEnv);
		expect(resolveHomeIntent("включи кухня", config)).toEqual({
			kind: "light",
			operation: "turn_on",
			entityIds: ["light.kitchen_main", "light.kitchen_accent"],
			matchedAlias: "кухня",
		});
	});

	it("matches scene aliases without requiring on/off phrase", () => {
		const config = resolveHomeAssistantConfig(enabledEnv);
		expect(resolveHomeIntent("bedroom reading", config)).toEqual({
			kind: "scene",
			sceneId: "scene.bedroom_reading",
			matchedAlias: "bedroom reading",
		});
	});

	it("matches scene aliases with punctuation", () => {
		const config = resolveHomeAssistantConfig(enabledEnv);
		expect(resolveHomeIntent("Bedroom, reading.", config)).toEqual({
			kind: "scene",
			sceneId: "scene.bedroom_reading",
			matchedAlias: "bedroom reading",
		});
	});

	it("returns unresolved light target when operation exists but no target is found", () => {
		const config = resolveHomeAssistantConfig(enabledEnv);
		expect(resolveHomeIntent("turn on lights", config)).toEqual({
			kind: "light",
			operation: "turn_on",
			entityIds: [],
		});
	});
});

describe("createHomeAssistantService", () => {
	it("returns null for non-light/non-scene transcript", async () => {
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: vi.fn(),
		});
		await expect(service.handleTranscript("what's the weather")).resolves.toBeNull();
	});

	it("calls Home Assistant light service with array payload", async () => {
		const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: fetchMock,
		});

		const handled = await service.handleTranscript("turn off kitchen");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://homeassistant.local:8123/api/services/light/turn_off",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer token",
				}),
				body: JSON.stringify({
					entity_id: ["light.kitchen_main", "light.kitchen_accent"],
				}),
			}),
		);
		expect(handled).toEqual(
			expect.objectContaining({
				integration: "home_assistant",
				operation: "light.turn_off",
				result: expect.objectContaining({ ok: true, statusCode: 200 }),
			}),
		);
	});

	it("calls Home Assistant scene service", async () => {
		const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: fetchMock,
		});

		const handled = await service.handleTranscript("movie time");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://homeassistant.local:8123/api/services/scene/turn_on",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					entity_id: "scene.movie_time",
				}),
			}),
		);
		expect(handled).toEqual(
			expect.objectContaining({
				operation: "scene.turn_on",
				entityId: "scene.movie_time",
				result: expect.objectContaining({ ok: true, statusCode: 200 }),
			}),
		);
	});

	it("returns language-appropriate unresolved target prompt", async () => {
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: vi.fn(),
		});

		const handled = await service.handleTranscript("выключи свет");

		expect(handled).toEqual(
			expect.objectContaining({
				result: expect.objectContaining({ ok: false, code: "ENTITY_UNRESOLVED" }),
				language: "ru",
			}),
		);
		expect(handled?.assistantText).toContain("[ru]");
	});

	it("returns failure result when Home Assistant request fails", async () => {
		const fetchMock = vi.fn(async () => new Response("not allowed", { status: 403 }));
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: fetchMock,
		});

		const handled = await service.handleTranscript("turn on kitchen");
		expect(handled).toEqual(
			expect.objectContaining({
				result: expect.objectContaining({ ok: false, code: "REQUEST_FAILED", statusCode: 403 }),
			}),
		);
	});

	it("executes typed light command through adapter", async () => {
		const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: fetchMock,
		});

		const handled = await service.executeCommand({
			name: "homeassistant.light.turn_off",
			args: {
				entity_id: ["light.kitchen_main", "light.kitchen_accent"],
			},
			languageHint: "en",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://homeassistant.local:8123/api/services/light/turn_off",
			expect.objectContaining({
				body: JSON.stringify({
					entity_id: ["light.kitchen_main", "light.kitchen_accent"],
				}),
			}),
		);
		expect(handled).toEqual(
			expect.objectContaining({
				operation: "light.turn_off",
				result: expect.objectContaining({
					ok: true,
				}),
			}),
		);
	});

	it("returns invalid result for malformed command args", async () => {
		const service = createHomeAssistantService({
			env: enabledEnv,
			fetchImpl: vi.fn(async () => new Response("[]", { status: 200 })),
		});

		const handled = await service.executeCommand({
			name: "homeassistant.light.turn_on",
			args: {
				entity_id: [],
			},
			languageHint: "en",
		});

		expect(handled.result).toEqual(
			expect.objectContaining({
				ok: false,
				code: "RESPONSE_INVALID",
			}),
		);
	});
});

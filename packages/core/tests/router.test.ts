import { describe, expect, it } from "vitest";
import { resolveHomeAssistantConfig } from "@herzen/integration-homeassistant";
import { createDeterministicIntentRouter } from "../src/intent/router.js";

const haConfig = resolveHomeAssistantConfig({
	HERZEN_HA_ENABLED: "1",
	HERZEN_HA_BASE_URL: "http://homeassistant.local:8123",
	HERZEN_HA_TOKEN: "token",
	HERZEN_HA_ALLOWED_LIGHTS: "light.kitchen,light.living_room",
	HERZEN_HA_LIGHT_ALIASES: "kitchen=light.kitchen,living room=light.living_room",
	HERZEN_HA_SCENE_ALIASES: "movie time=scene.movie_time",
});

describe("deterministic intent router", () => {
	it("routes to execute for known HA light intents", () => {
		const router = createDeterministicIntentRouter({ homeAssistantConfig: haConfig });
		const decision = router.route({
			sessionId: "session-1",
			laneKey: "session:session-1:trigger",
			transcript: "turn on kitchen",
			detectedLanguage: "en",
		});

		expect(decision).toMatchObject({
			kind: "execute",
			intentName: "homeassistant.light.turn_on",
			command: {
				name: "homeassistant.light.turn_on",
				policyScope: "ha:write",
			},
		});
	});

	it("routes to clarify when deterministic intent misses required entities", () => {
		const router = createDeterministicIntentRouter({ homeAssistantConfig: haConfig });
		const decision = router.route({
			sessionId: "session-1",
			laneKey: "session:session-1:trigger",
			transcript: "turn off lights",
			detectedLanguage: "en",
		});

		expect(decision).toEqual(
			expect.objectContaining({
				kind: "clarify",
				missingFields: ["entity_id"],
			}),
		);
	});

	it("routes to respond when no deterministic intent matches", () => {
		const router = createDeterministicIntentRouter({ homeAssistantConfig: haConfig });
		const decision = router.route({
			sessionId: "session-1",
			laneKey: "session:session-1:trigger",
			transcript: "what is the weather",
		});

		expect(decision.kind).toBe("respond");
	});

	it("routes to reject for policy-blocked transcripts", () => {
		const router = createDeterministicIntentRouter({ homeAssistantConfig: haConfig });
		const decision = router.route({
			sessionId: "session-1",
			laneKey: "session:session-1:trigger",
			transcript: "please rm -rf /",
		});

		expect(decision).toMatchObject({
			kind: "reject",
			code: "POLICY_REJECTED",
		});
	});
});

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveHomeAssistantConfig } from "@herzen/integration-homeassistant";
import { createDeterministicIntentRouter } from "../src/intent/router.js";
import {
	formatReplayReport,
	loadReplaySessionInput,
	replayDeterministicSession,
} from "../src/replay/harness.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/replay", import.meta.url));

describe("replay harness", () => {
	it("replays deterministic routes and computes metrics", () => {
		const router = createDeterministicIntentRouter({
			homeAssistantConfig: resolveHomeAssistantConfig({
				HERZEN_HA_ENABLED: "1",
				HERZEN_HA_BASE_URL: "http://homeassistant.local:8123",
				HERZEN_HA_TOKEN: "token",
				HERZEN_HA_ALLOWED_LIGHTS: "light.kitchen,light.living_room",
				HERZEN_HA_LIGHT_ALIASES: "kitchen=light.kitchen",
			}),
		});

		const input = loadReplaySessionInput({
			sessionId: "session-fixture",
			conversationsFile: join(fixtureDir, "session-fixture.conversation.jsonl"),
			controlSessionFile: join(fixtureDir, "session-fixture.control.jsonl"),
		});
		expect(input.turns).toHaveLength(3);

		const report = replayDeterministicSession({
			sessionId: input.sessionId,
			router,
			turns: input.turns,
			recordedModelRoutes: input.recordedModelRoutes,
			nowIso: () => "2026-02-27T00:00:10.000Z",
		});

		expect(report.mode).toBe("deterministic_with_recorded_model");
		expect(report.metrics.routeDistribution).toEqual({
			execute: 1,
			clarify: 1,
			respond: 1,
			reject: 0,
		});
		expect(report.metrics.clarificationRate).toBeCloseTo(1 / 3, 5);
		expect(report.metrics.modelComparison).toMatchObject({
			comparedTurns: 3,
			matchCount: 2,
			mismatchCount: 1,
		});

		const formatted = formatReplayReport(report);
		expect(formatted).toContain("Replay Report: session-fixture");
		expect(formatted).toContain("clarify=1");
	});
});

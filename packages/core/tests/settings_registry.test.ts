import { describe, expect, it } from "vitest";
import {
	getSettingMeta,
	listSettingsByScope,
	resolveSettings,
} from "../src/settings/registry.js";

describe("settings registry", () => {
	it("resolves defaults with stable typed output", () => {
		const settings = resolveSettings({});

		expect(settings).toEqual({
			runtime: {
				profile: "voice",
			},
			logging: {
				level: "info",
				transcriptEnabled: false,
				audioInputEnabled: false,
				dialogEnabled: true,
				dialogMarkdownEnabled: true,
				perfEnabled: true,
				perfSampleMs: 1000,
				retentionEnabled: true,
				retentionMaxBytes: 50 * 1024 * 1024,
				retentionMaxAgeDays: 14,
				retentionPruneOnStartup: true,
			},
			followup: {
				enabled: false,
				windowSeconds: 8,
				maxTurns: 3,
				stopPhrases: [],
			},
			control: {
				allowedScopes: ["ha:write"],
			},
			ha: {
				enabled: false,
				timeoutMs: 5000,
			},
		});
	});

	it("parses valid values and falls back for invalid values", () => {
		const settings = resolveSettings({
			HERZEN_RUNTIME_PROFILE: "hybrid",
			HERZEN_LOG_LEVEL: "warn",
			HERZEN_LOG_TRANSCRIPT: "1",
			HERZEN_PERF_SAMPLE_MS: "bad",
			HERZEN_LOG_RETENTION_MAX_BYTES: "4000",
			HERZEN_LOG_RETENTION_MAX_DAYS: "3",
			HERZEN_FOLLOWUP_ENABLED: "yes",
			HERZEN_FOLLOWUP_WINDOW_SECONDS: "12.5",
			HERZEN_FOLLOWUP_MAX_TURNS: "4",
			HERZEN_FOLLOWUP_STOP_PHRASES: " stop,thanks,stop ",
			HERZEN_POLICY_ALLOWED_SCOPES: "ha:write,diag:read",
			HERZEN_HA_ENABLED: "1",
			HERZEN_HA_TIMEOUT_MS: "9000",
		});

		expect(settings.runtime.profile).toBe("hybrid");
		expect(settings.logging.level).toBe("warn");
		expect(settings.logging.transcriptEnabled).toBe(true);
		expect(settings.logging.perfSampleMs).toBe(1000);
		expect(settings.logging.retentionMaxBytes).toBe(4000);
		expect(settings.logging.retentionMaxAgeDays).toBe(3);
		expect(settings.followup).toEqual({
			enabled: true,
			windowSeconds: 12.5,
			maxTurns: 4,
			stopPhrases: ["stop", "thanks"],
		});
		expect(settings.control).toEqual({
			allowedScopes: ["ha:write", "diag:read"],
		});
		expect(settings.ha).toEqual({
			enabled: true,
			timeoutMs: 9000,
		});
	});

	it("exposes metadata lookup and scope listings", () => {
		const meta = getSettingMeta("logging.level");
		expect(meta).toMatchObject({
			key: "logging.level",
			envName: "HERZEN_LOG_LEVEL",
			scope: "logging",
			sensitive: false,
			mutability: "runtime",
		});

		const haSettings = listSettingsByScope("ha");
		expect(haSettings.length).toBeGreaterThan(0);
		expect(haSettings.every((item) => item.scope === "ha")).toBe(true);
	});
});

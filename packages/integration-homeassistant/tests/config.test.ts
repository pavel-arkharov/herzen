import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveHomeAssistantConfig } from "../src/config.js";

describe("resolveHomeAssistantConfig", () => {
	it("returns disabled defaults when integration is disabled", () => {
		expect(resolveHomeAssistantConfig({})).toEqual({
			enabled: false,
			baseUrl: "",
			token: "",
			timeoutMs: 5000,
			allowedLights: [],
			aliasToLightEntityIds: {},
			aliasToSceneEntityId: {},
		});
	});

	it("resolves enabled config with explicit allowlist", () => {
		const config = resolveHomeAssistantConfig({
			HERZEN_HA_ENABLED: "1",
			HERZEN_HA_BASE_URL: "http://homeassistant.local:8123",
			HERZEN_HA_TOKEN: "token",
			HERZEN_HA_ALLOWED_LIGHTS: "light.kitchen,light.living_room",
			HERZEN_HA_LIGHT_ALIASES: "kitchen=light.kitchen, living room=light.living_room",
			HERZEN_HA_TIMEOUT_MS: "7000",
		});

		expect(config).toEqual({
			enabled: true,
			baseUrl: "http://homeassistant.local:8123",
			token: "token",
			timeoutMs: 7000,
			allowedLights: ["light.kitchen", "light.living_room"],
			aliasToLightEntityIds: {
				kitchen: ["light.kitchen"],
				"living room": ["light.living_room"],
			},
			aliasToSceneEntityId: {},
			defaultLight: undefined,
		});
	});

	it("derives allowlist from aliases when allowlist is omitted", () => {
		const config = resolveHomeAssistantConfig({
			HERZEN_HA_ENABLED: "1",
			HERZEN_HA_BASE_URL: "http://127.0.0.1:8123",
			HERZEN_HA_TOKEN: "token",
			HERZEN_HA_LIGHT_ALIASES: "кухня=light.kitchen,bedroom=light.bedroom",
		});

		expect(config.allowedLights).toEqual(["light.kitchen", "light.bedroom"]);
	});

	it("supports multi-light aliases and scene aliases", () => {
		const config = resolveHomeAssistantConfig({
			HERZEN_HA_ENABLED: "1",
			HERZEN_HA_BASE_URL: "http://127.0.0.1:8123",
			HERZEN_HA_TOKEN: "token",
			HERZEN_HA_ALLOWED_LIGHTS: "light.kitchen_main,light.kitchen_accent",
			HERZEN_HA_LIGHT_ALIASES: "kitchen=light.kitchen_main|light.kitchen_accent",
			HERZEN_HA_SCENE_ALIASES: "bedroom reading=scene.bedroom_reading",
		});

		expect(config.aliasToLightEntityIds).toEqual({
			kitchen: ["light.kitchen_main", "light.kitchen_accent"],
		});
		expect(config.aliasToSceneEntityId).toEqual({
			"bedroom reading": "scene.bedroom_reading",
		});
	});

	it("throws for malformed alias entries", () => {
		expect(() =>
			resolveHomeAssistantConfig({
				HERZEN_HA_ENABLED: "1",
				HERZEN_HA_BASE_URL: "http://127.0.0.1:8123",
				HERZEN_HA_TOKEN: "token",
				HERZEN_HA_LIGHT_ALIASES: "kitchen-light.kitchen",
			}),
		).toThrow("HERZEN_HA_LIGHT_ALIASES");
	});

	it("throws when enabled without any entities", () => {
		expect(() =>
			resolveHomeAssistantConfig({
				HERZEN_HA_ENABLED: "1",
				HERZEN_HA_BASE_URL: "http://127.0.0.1:8123",
				HERZEN_HA_TOKEN: "token",
			}),
		).toThrow("At least one light must be configured");
	});

	it("resolves base url and token from *_FILE env variables", () => {
		const secretsDir = mkdtempSync(join(tmpdir(), "herzen-ha-config-"));
		const baseUrlPath = join(secretsDir, "base_url");
		const tokenPath = join(secretsDir, "token");
		writeFileSync(baseUrlPath, "http://127.0.0.1:8123\n", "utf8");
		writeFileSync(tokenPath, "token-from-file\n", "utf8");
		chmodSync(tokenPath, 0o600);

		const config = resolveHomeAssistantConfig({
			HERZEN_HA_ENABLED: "1",
			HERZEN_HA_BASE_URL_FILE: baseUrlPath,
			HERZEN_HA_TOKEN_FILE: tokenPath,
			HERZEN_HA_DEFAULT_LIGHT: "light.kitchen",
		});

		expect(config.baseUrl).toBe("http://127.0.0.1:8123");
		expect(config.token).toBe("token-from-file");
		expect(config.allowedLights).toEqual(["light.kitchen"]);
	});

	it("resolves base url and token from HERZEN_HA_SECRETS_DIR", () => {
		const secretsDir = mkdtempSync(join(tmpdir(), "herzen-ha-secrets-dir-"));
		writeFileSync(join(secretsDir, "base_url"), "http://homeassistant.local:8123\n", "utf8");
		writeFileSync(join(secretsDir, "token"), "token-from-secrets-dir\n", "utf8");
		chmodSync(join(secretsDir, "token"), 0o600);

		const config = resolveHomeAssistantConfig({
			HERZEN_HA_ENABLED: "1",
			HERZEN_HA_SECRETS_DIR: secretsDir,
			HERZEN_HA_DEFAULT_LIGHT: "light.kitchen",
		});

		expect(config.baseUrl).toBe("http://homeassistant.local:8123");
		expect(config.token).toBe("token-from-secrets-dir");
		expect(config.allowedLights).toEqual(["light.kitchen"]);
	});

	it("rejects token files that are not owner-only", () => {
		if (process.platform === "win32") return;
		const secretsDir = mkdtempSync(join(tmpdir(), "herzen-ha-perms-"));
		const tokenPath = join(secretsDir, "token");
		writeFileSync(tokenPath, "weak-token\n", "utf8");
		chmodSync(tokenPath, 0o644);

		expect(() =>
			resolveHomeAssistantConfig({
				HERZEN_HA_ENABLED: "1",
				HERZEN_HA_BASE_URL: "http://127.0.0.1:8123",
				HERZEN_HA_TOKEN_FILE: tokenPath,
				HERZEN_HA_DEFAULT_LIGHT: "light.kitchen",
			}),
		).toThrow("must be owner-only");
	});
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	loadRuntimeEnvOverrides,
	runtimeSettingsFilePath,
	saveRuntimeEnvOverrides,
} from "../src/settings/runtime_overrides.js";

function createTempRoot(prefix: string): string {
	const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

describe("runtime overrides", () => {
	it("loads string env-style overrides from runtime settings file", () => {
		const root = createTempRoot("runtime-overrides");
		const controlDir = join(root, "control");
		mkdirSync(controlDir, { recursive: true });
		writeFileSync(
			runtimeSettingsFilePath(controlDir),
			JSON.stringify({
				HERZEN_LOG_LEVEL: "warn",
				HERZEN_LOG_TRANSCRIPT: "true",
				invalid_key: "ignored",
				HERZEN_NON_STRING: 1,
			}),
			"utf8",
		);

		const overrides = loadRuntimeEnvOverrides(controlDir);
		expect(overrides).toEqual({
			HERZEN_LOG_LEVEL: "warn",
			HERZEN_LOG_TRANSCRIPT: "true",
		});
	});

	it("returns empty object and warns on invalid JSON", () => {
		const root = createTempRoot("runtime-overrides-invalid");
		const controlDir = join(root, "control");
		mkdirSync(controlDir, { recursive: true });
		writeFileSync(runtimeSettingsFilePath(controlDir), "{bad json", "utf8");
		const warn = vi.fn();

		const overrides = loadRuntimeEnvOverrides(controlDir, { warn });
		expect(overrides).toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("saves runtime env overrides atomically", async () => {
		const root = createTempRoot("runtime-overrides-save");
		const controlDir = join(root, "control");
		await saveRuntimeEnvOverrides(controlDir, {
			HERZEN_RUNTIME_PROFILE: "text",
			HERZEN_TRIGGER_MODE: "stdin",
		});

		expect(loadRuntimeEnvOverrides(controlDir)).toEqual({
			HERZEN_RUNTIME_PROFILE: "text",
			HERZEN_TRIGGER_MODE: "stdin",
		});
	});
});

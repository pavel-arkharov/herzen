import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	loadRuntimeOverrides,
	resolveRuntimeSettingItems,
	runtimeSettingsFilePath,
	saveRuntimeOverrides,
	setRuntimeSettingOverride,
} from "../src/runtime_settings.js";

function createTempRoot(prefix: string): string {
	const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

describe("runtime settings", () => {
	it("saves and loads persisted overrides", async () => {
		const root = createTempRoot("tui-settings");
		const filePath = runtimeSettingsFilePath(root);
		await saveRuntimeOverrides(filePath, {
			HERZEN_LOG_LEVEL: "warn",
			HERZEN_LOG_TRANSCRIPT: "true",
		});
		const overrides = loadRuntimeOverrides(filePath);
		expect(overrides).toEqual({
			HERZEN_LOG_LEVEL: "warn",
			HERZEN_LOG_TRANSCRIPT: "true",
		});
	});

	it("resolves editable setting items and updates override map", () => {
		const items = resolveRuntimeSettingItems({}, {
			HERZEN_LOG_LEVEL: "error",
			HERZEN_LOG_TRANSCRIPT: "true",
		});
		expect(items.length).toBeGreaterThanOrEqual(3);
		expect(items[0]).toMatchObject({ key: "logging.level", value: "error" });

		const next = setRuntimeSettingOverride({}, "logging.perf_enabled", "false");
		expect(next).toEqual({
			HERZEN_LOG_PERF: "false",
		});
	});
});

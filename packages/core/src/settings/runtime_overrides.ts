import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RUNTIME_SETTINGS_FILE = "runtime_settings.json";
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

export interface RuntimeOverridesLogger {
	warn: (message: string, error?: unknown) => void;
}

export function runtimeSettingsFilePath(controlDir: string): string {
	return join(controlDir, RUNTIME_SETTINGS_FILE);
}

export async function saveRuntimeEnvOverrides(
	controlDir: string,
	overrides: Record<string, string>,
): Promise<void> {
	const filePath = runtimeSettingsFilePath(controlDir);
	mkdirSync(controlDir, { recursive: true });
	const tempPath = `${filePath}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
	await rename(tempPath, filePath);
}

export function loadRuntimeEnvOverrides(
	controlDir: string,
	logger: RuntimeOverridesLogger = console,
): NodeJS.ProcessEnv {
	const filePath = runtimeSettingsFilePath(controlDir);
	const raw = readUtf8(filePath);
	if (raw === undefined) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		logger.warn(`Failed to parse runtime settings overrides at "${filePath}".`, err);
		return {};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		logger.warn(`Runtime settings overrides at "${filePath}" must be a JSON object.`);
		return {};
	}

	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!ENV_KEY_PATTERN.test(key)) continue;
		if (typeof value !== "string") continue;
		result[key] = value;
	}
	return result;
}

function readUtf8(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

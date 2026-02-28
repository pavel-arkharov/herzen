import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "data");

export function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

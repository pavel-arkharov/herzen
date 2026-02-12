import { recordWav, playAudio, beep } from "@herzen/audio";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { speak } from "@herzen/tts";
import { createRuntime } from "./runtime.js";
import { createTriggerSource, resolveTriggerMode } from "./trigger/factory.js";
import { isTriggerError } from "./trigger/types.js";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

const outDir = join(resolveDataRoot(), "audio");
mkdirSync(outDir, { recursive: true });

async function handleTrigger() {
	const file = join(outDir, `test-${Date.now()}.wav`);

	console.log("Triggered. Recording 5 seconds…");
	await beep();
	await recordWav(file, 5);

	console.log("Playing back…");
	await playAudio(file);
	await speak("[en] I heard you.");
	console.log("Done:", file);
}

const runtime = createRuntime({
	resolveTriggerMode,
	createTriggerSource,
	isTriggerError,
	onTrigger: handleTrigger,
	logger: console,
	exit: (code) => {
		process.exit(code);
	},
});

process.on("SIGINT", () => {
	console.log("\nShutting down…");
	void runtime.shutdown(0);
});

process.on("SIGTERM", () => {
	console.log("\nShutting down…");
	void runtime.shutdown(0);
});

void runtime.run();

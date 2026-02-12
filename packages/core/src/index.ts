import { recordWav, playAudio, beep } from "@herzen/audio";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { speak } from "@herzen/tts";
import { createTriggerSource, resolveTriggerMode } from "./trigger/factory.js";
import { isTriggerError, type TriggerMode, type TriggerSource } from "./trigger/types.js";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

const outDir = join(resolveDataRoot(), "audio");
mkdirSync(outDir, { recursive: true });

let triggerSource: TriggerSource | null = null;
let shuttingDown = false;

async function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;

	try {
		await triggerSource?.stop();
	} catch (err) {
		console.error("Trigger source cleanup error:", err);
	}

	process.exit(code);
}

process.on("SIGINT", () => {
	console.log("\nShutting down…");
	void shutdown(0);
});

process.on("SIGTERM", () => {
	console.log("\nShutting down…");
	void shutdown(0);
});

function listeningMessage(mode: TriggerMode): string {
	if (mode === "stdin") return "\nListening… (press Enter to trigger)";
	return `\nListening… (trigger mode: ${mode})`;
}

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

async function run() {
	let triggerMode: TriggerMode;
	try {
		triggerMode = resolveTriggerMode();
	} catch (err) {
		console.error(err instanceof Error ? err.message : "Unknown trigger mode resolution error.");
		await shutdown(1);
		return;
	}

	triggerSource = createTriggerSource(triggerMode);

	try {
		await triggerSource.start();
	} catch (err) {
		if (isTriggerError(err)) {
			console.error(`Failed to start trigger source (${err.code}): ${err.message}`);
		} else {
			console.error("Failed to start trigger source:", err);
		}
		await shutdown(1);
		return;
	}

	console.log(`Trigger mode: ${triggerMode}`);
	console.log(listeningMessage(triggerMode));

	while (!shuttingDown) {
		try {
			await triggerSource.nextTrigger();
			await handleTrigger();
			console.log(listeningMessage(triggerMode));
		} catch (err) {
			if (shuttingDown) return;

			if (isTriggerError(err)) {
				if (err.code === "SOURCE_CLOSED") {
					await shutdown(0);
					return;
				}

				if (err.code === "NOT_IMPLEMENTED") {
					console.error(err.message);
					await shutdown(1);
					return;
				}

				if (err.code === "SOURCE_FAILED") {
					console.error(`Trigger source error: ${err.message}`);
					await shutdown(1);
					return;
				}
			}

			console.error("Error:", err);
			console.log(listeningMessage(triggerMode));
		}
	}
}

void run();

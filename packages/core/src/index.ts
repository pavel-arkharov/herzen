import { recordWav, playAudio, beep } from "@herzen/audio";
import { transcribeWav, SttError } from "@herzen/stt";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { speak } from "@herzen/tts";
import { createRuntime } from "./runtime.js";
import { createSttTriggerHandler, type SttLogEntry } from "./turn.js";
import { createTriggerSource, resolveTriggerMode } from "./trigger/factory.js";
import { isTriggerError } from "./trigger/types.js";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

const dataRoot = resolveDataRoot();
const outDir = join(dataRoot, "audio");
const logsDir = join(dataRoot, "logs");
const sttLogFile = join(logsDir, "stt.jsonl");
mkdirSync(outDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

async function appendSttLog(entry: SttLogEntry): Promise<void> {
	await appendFile(sttLogFile, `${JSON.stringify(entry)}\n`, "utf8");
}

async function recordWithProgress(file: string, seconds: number): Promise<void> {
	const startedAt = Date.now();
	const barWidth = 26;

	const render = (forceDone = false) => {
		const elapsedSeconds = forceDone ? seconds : Math.min((Date.now() - startedAt) / 1000, seconds);
		const ratio = Math.max(0, Math.min(1, elapsedSeconds / seconds));
		const filled = Math.round(barWidth * ratio);
		const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
		process.stdout.write(`\rRecording [${bar}] ${elapsedSeconds.toFixed(1)}s/${seconds.toFixed(1)}s`);
		if (forceDone) process.stdout.write("\n");
	};

	render(false);
	const ticker = setInterval(() => render(false), 100);

	try {
		await recordWav(file, seconds);
	} finally {
		clearInterval(ticker);
		render(true);
	}
}

const handleTrigger = createSttTriggerHandler({
	outDir,
	getEnv: () => process.env,
	now: () => Date.now(),
	nowIso: () => new Date().toISOString(),
	logger: console,
	recordAudio: async (file, seconds) => {
		await beep();
		await recordWithProgress(file, seconds);
	},
	transcribeWav,
	isSttError: (err): err is SttError => err instanceof SttError,
	appendSttLog,
	playAudio,
	speak,
});

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

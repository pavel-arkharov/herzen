import { recordWav, playAudio, beep } from "@herzen/audio";
import { transcribeWav, SttError } from "@herzen/stt";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
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

const dataRoot = resolveDataRoot();
const outDir = join(dataRoot, "audio");
const logsDir = join(dataRoot, "logs");
const sttLogFile = join(logsDir, "stt.jsonl");
const DEFAULT_RECORD_SECONDS = 3;
const FALLBACK_SPEECH = "[en] I couldn't understand that.";
mkdirSync(outDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

function resolveSttLanguageMode(): string {
	const fromEnv = process.env.HERZEN_STT_LANGUAGE?.trim();
	return fromEnv || "auto";
}

function resolveRecordSeconds(rawSeconds = process.env.HERZEN_RECORD_SECONDS): number {
	const trimmed = rawSeconds?.trim();
	if (!trimmed) return DEFAULT_RECORD_SECONDS;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.error(
			`Invalid HERZEN_RECORD_SECONDS "${rawSeconds}". Falling back to ${DEFAULT_RECORD_SECONDS} seconds.`,
		);
		return DEFAULT_RECORD_SECONDS;
	}
	return Math.min(parsed, 30);
}

function resolvePlaybackEnabled(rawPlayback = process.env.HERZEN_PLAYBACK): boolean {
	const normalized = rawPlayback?.trim().toLowerCase();
	if (!normalized) return false;
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function hasCyrillic(text: string): boolean {
	return /[А-Яа-яЁё]/.test(text);
}

function confirmationSpeech(transcript: string, language: string): string {
	if (language === "ru" || hasCyrillic(transcript)) {
		return `[ru] Я услышал: ${transcript}`;
	}
	return `[en] I heard: ${transcript}`;
}

function detectedLanguageLabel(transcript: string, language: string): "en" | "ru" {
	if (language.toLowerCase().startsWith("ru") || hasCyrillic(transcript)) return "ru";
	return "en";
}

async function appendSttLog(entry: {
	timestamp: string;
	audioFile: string;
	durationMs: number;
	latencyMs: number;
	languageMode: string;
	language?: string;
	transcript?: string;
	errorCode?: string;
}): Promise<void> {
	try {
		await appendFile(sttLogFile, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (err) {
		console.error("Failed to write STT log:", err);
	}
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

async function handleTrigger() {
	const file = join(outDir, `test-${Date.now()}.wav`);
	const languageMode = resolveSttLanguageMode();
	const recordSeconds = resolveRecordSeconds();
	const playbackEnabled = resolvePlaybackEnabled();

	console.log(`Triggered. Recording ${recordSeconds.toFixed(1)} seconds…`);
	await beep();
	await recordWithProgress(file, recordSeconds);

	let latencyMs: number;
	let durationMs: number;
	let transcript = "";
	let language = "auto";
	let errorCode: string | undefined;
	const sttStart = Date.now();

	try {
		const sttResult = await transcribeWav(file);
		latencyMs = sttResult.durationMs;
		durationMs = sttResult.durationMs;
		transcript = sttResult.text.trim();
		language = sttResult.language;
		if (transcript) {
			const detected = detectedLanguageLabel(transcript, language);
			console.log(`[${detected} detected]`);
		} else {
			console.log("[no speech detected]");
		}
	} catch (err) {
		latencyMs = Date.now() - sttStart;
		durationMs = latencyMs;
		if (err instanceof SttError) {
			errorCode = err.code;
			console.error(`STT error (${err.code}): ${err.message}`);
		} else {
			errorCode = "UNKNOWN";
			console.error("STT error:", err);
		}
	}

	await appendSttLog({
		timestamp: new Date().toISOString(),
		audioFile: file,
		durationMs,
		latencyMs,
		languageMode,
		language,
		transcript: transcript || undefined,
		errorCode,
	});

	if (playbackEnabled) {
		console.log("Playing back…");
		await playAudio(file);
	} else {
		console.log("Playback skipped. Set HERZEN_PLAYBACK=1 to enable.");
	}

	if (transcript) {
		await speak(confirmationSpeech(transcript, language));
	} else {
		await speak(FALLBACK_SPEECH);
	}

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

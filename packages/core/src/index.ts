import { recordWav, playAudio, beep } from "@herzen/audio";
import { transcribeWav, SttError } from "@herzen/stt";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { speak } from "@herzen/tts";
import { createLogger, toStructuredSttTurnEntry } from "./logging.js";
import { createRuntime, type RuntimeController } from "./runtime.js";
import { createSttTriggerHandler, type SttLogEntry } from "./turn.js";
import {
	createTriggerSource,
	resolveInitialTriggerModeInteractive,
	shouldSwitchToStdinAfterWakewordFailure,
} from "./trigger/factory.js";
import { isTriggerError, type TriggerMode, type TriggerSource } from "./trigger/types.js";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

function resolveDataRoot(rawDataDir = process.env.HERZEN_DATA_DIR): string {
	const trimmed = rawDataDir?.trim();
	if (!trimmed) return defaultDataRoot;
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

const dataRoot = resolveDataRoot();
const outDir = join(dataRoot, "audio");
const logsDir = join(dataRoot, "logs");
mkdirSync(outDir, { recursive: true });

const coreLogger = createLogger({
	logsDir,
	component: "core",
});

const triggerLogger = createLogger({
	logsDir,
	component: "trigger",
});

const sttLogger = createLogger({
	logsDir,
	component: "stt",
});

function asMessage(args: unknown[]): string {
	return format(...args);
}

async function appendSttLog(entry: SttLogEntry): Promise<void> {
	await sttLogger.appendJsonl(
		"stt",
		toStructuredSttTurnEntry(entry, {
			transcriptEnabled: sttLogger.transcriptEnabled,
		}),
	);
}

const sttTurnLogger = {
	log: (...args: unknown[]) => {
		sttLogger.info("stt.status", { message: asMessage(args) });
	},
	error: (...args: unknown[]) => {
		sttLogger.error("stt.error", { message: asMessage(args) });
	},
};

const runtimeLogger = {
	log: (...args: unknown[]) => {
		triggerLogger.info("trigger.status", { message: asMessage(args) });
	},
	error: (...args: unknown[]) => {
		triggerLogger.error("trigger.error", { message: asMessage(args) });
	},
};

let runtime: RuntimeController | null = null;

async function flushAndExit(code: number): Promise<void> {
	await Promise.all([coreLogger.drain(), triggerLogger.drain(), sttLogger.drain()]);
	process.exit(code);
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
	logger: sttTurnLogger,
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

interface StartupTriggerRuntimeConfig {
	triggerMode: TriggerMode;
	createSource: (mode: TriggerMode) => TriggerSource;
}

async function resolveStartupTriggerRuntimeConfig(): Promise<StartupTriggerRuntimeConfig> {
	const selectedMode = await resolveInitialTriggerModeInteractive();
	if (selectedMode !== "wakeword") {
		return {
			triggerMode: selectedMode,
			createSource: createTriggerSource,
		};
	}

	const wakewordSource = createTriggerSource("wakeword");
	try {
		await wakewordSource.start();
		return {
			triggerMode: "wakeword",
			createSource: (mode) => {
				if (mode !== "wakeword") return createTriggerSource(mode);
				return createPrestartedSource(wakewordSource);
			},
		};
	} catch (err) {
		if (isTriggerError(err) && (err.code === "SOURCE_FAILED" || err.code === "SOURCE_CLOSED")) {
			process.stderr.write(`Wakeword unavailable: ${err.message}\n`);
			const shouldSwitch = await shouldSwitchToStdinAfterWakewordFailure();
			if (shouldSwitch) {
				try {
					await wakewordSource.stop();
				} catch {
					// Ignore cleanup failure and proceed with stdin fallback.
				}
				return {
					triggerMode: "stdin",
					createSource: createTriggerSource,
				};
			}
		}
		try {
			await wakewordSource.stop();
		} catch {
			// Ignore cleanup failure on startup path.
		}
		throw err;
	}
}

function createPrestartedSource(source: TriggerSource): TriggerSource {
	let stopped = false;

	return {
		start() {
			// Source was started during startup resolution.
		},
		nextTrigger() {
			return source.nextTrigger();
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await source.stop();
		},
	};
}

async function main(): Promise<void> {
	let startupConfig: StartupTriggerRuntimeConfig;
	try {
		startupConfig = await resolveStartupTriggerRuntimeConfig();
	} catch (err) {
		runtimeLogger.error("Failed to resolve startup trigger mode:", err);
		await flushAndExit(1);
		return;
	}

	runtime = createRuntime({
		resolveTriggerMode: () => startupConfig.triggerMode,
		createTriggerSource: startupConfig.createSource,
		isTriggerError,
		onTrigger: handleTrigger,
		logger: runtimeLogger,
		exit: flushAndExit,
	});

	await runtime.run();
}

process.on("SIGINT", () => {
	coreLogger.info("core.shutdown_requested", { message: "\nShutting down…", signal: "SIGINT" });
	if (runtime) {
		void runtime.shutdown(0);
		return;
	}
	void flushAndExit(0);
});

process.on("SIGTERM", () => {
	coreLogger.info("core.shutdown_requested", { message: "\nShutting down…", signal: "SIGTERM" });
	if (runtime) {
		void runtime.shutdown(0);
		return;
	}
	void flushAndExit(0);
});

void main();

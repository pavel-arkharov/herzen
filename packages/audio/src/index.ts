import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createSileroVadSession, type VadSession } from "@herzen/vad";

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_FRAME_SAMPLES = 512;
const DEFAULT_START_THRESHOLD = 0.55;
const DEFAULT_END_THRESHOLD = 0.35;
const DEFAULT_MIN_SECONDS = 1;
const DEFAULT_MAX_SECONDS = 12;
const DEFAULT_SILENCE_SECONDS = 0.7;
const DEFAULT_NO_SPEECH_TIMEOUT_SECONDS = 4;
const DEFAULT_STOP_GRACE_MS = 400;
const START_CONSECUTIVE_FRAMES = 3;
const PCM_BYTES_PER_SAMPLE = 2;
const MAX_REC_STDERR_CAPTURE_CHARS = 8_192;

export type AdaptiveStopReason = "trailing_silence" | "max_seconds" | "no_speech_timeout";

export interface AdaptiveRecordResult {
	durationSeconds: number;
	stopReason: AdaptiveStopReason;
}

export interface AdaptiveRecordConfig {
	minSeconds?: number;
	maxSeconds?: number;
	silenceSeconds?: number;
	noSpeechTimeoutSeconds?: number;
	startThreshold?: number;
	endThreshold?: number;
	frameSamples?: number;
	sampleRate?: number;
	modelPath?: string;
	dataDir?: string;
	vadSession?: VadSession;
	stopGraceMs?: number;
}

export type AudioRecordErrorCode = "CONFIG_INVALID" | "RECORD_FAILED" | "VAD_FAILED" | "WRITE_FAILED";

interface AudioRecordErrorOptions {
	cause?: unknown;
}

export class AudioRecordError extends Error {
	readonly code: AudioRecordErrorCode;
	declare readonly cause?: unknown;

	constructor(code: AudioRecordErrorCode, message: string, options?: AudioRecordErrorOptions) {
		super(message);
		this.name = "AudioRecordError";
		this.code = code;
		this.cause = options?.cause;
	}
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("error", reject);
		p.on("exit", (code: number | null) =>
			code === 0 ? resolve() : (
				reject(new Error(`${cmd} exited with code ${code}`))
			),
		);
	});
}

export async function recordWav(
	outFile: string,
	seconds: number,
	sampleRate = 16000,
): Promise<void> {
	// Record with device defaults, then resample deterministically for STT.
	await run("rec", [
		"-q",
		"-c",
		"1",
		outFile,
		"trim",
		"0",
		String(seconds),
		"rate",
		"-v",
		String(sampleRate),
	]);
}

export async function recordAdaptiveWav(
	outFile: string,
	config: AdaptiveRecordConfig = {},
): Promise<AdaptiveRecordResult> {
	const resolved = resolveAdaptiveRecordConfig(config);
	const vadSession = config.vadSession ?? (await createVadSession(config, resolved));
	await vadSession.reset();

	const frameBytes = resolved.frameSamples * PCM_BYTES_PER_SAMPLE;
	const recArgs = [
		"-q",
		"-c",
		"1",
		"-r",
		String(resolved.sampleRate),
		"-b",
		"16",
		"-e",
		"signed-integer",
		"-t",
		"raw",
		"-",
	];

	const child = spawn("rec", recArgs, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stopReason: AdaptiveStopReason | null = null;
	let stopRequested = false;
	let processFatalError: unknown;
	let spawnError: unknown;
	let stopPromise: Promise<void> | null = null;
	let stderrTail = "";
	let pendingFrameBytes = Buffer.alloc(0);
	const rawChunks: Buffer[] = [];
	let processQueue = Promise.resolve();

	let endpointState: "waiting_for_speech" | "in_speech" | "trailing_silence" = "waiting_for_speech";
	let speechStartStreak = 0;
	let trailingSilenceSeconds = 0;
	let totalSamplesProcessed = 0;
	const frameDurationSeconds = resolved.frameSamples / resolved.sampleRate;

	const requestStop = () => {
		stopRequested = true;
		if (stopPromise) return;
		stopPromise = terminateProcess(child, resolved.stopGraceMs).catch((err) => {
			processFatalError = processFatalError ?? err;
		});
	};

	const processFrame = async (frameChunk: Buffer): Promise<void> => {
		if (stopReason || processFatalError) return;
		const frame = pcm16MonoToFloat32(frameChunk);
		let probability: number;
			try {
				probability = await vadSession.processFrame(frame);
			} catch (err) {
				const details = err instanceof Error ? err.message : String(err);
				processFatalError = new AudioRecordError(
					"VAD_FAILED",
					`Adaptive VAD inference failed: ${details}`,
					{ cause: err },
				);
				requestStop();
				return;
			}

		totalSamplesProcessed += resolved.frameSamples;
		const elapsedSeconds = totalSamplesProcessed / resolved.sampleRate;

		if (endpointState === "waiting_for_speech") {
			if (probability >= resolved.startThreshold) {
				speechStartStreak += 1;
				if (speechStartStreak >= START_CONSECUTIVE_FRAMES) {
					endpointState = "in_speech";
				}
			} else {
				speechStartStreak = 0;
			}

			if (elapsedSeconds >= resolved.noSpeechTimeoutSeconds) {
				stopReason = "no_speech_timeout";
				requestStop();
				return;
			}
		}

		if (endpointState === "in_speech") {
			if (probability <= resolved.endThreshold) {
				endpointState = "trailing_silence";
				trailingSilenceSeconds = frameDurationSeconds;
			}
		} else if (endpointState === "trailing_silence") {
			if (probability <= resolved.endThreshold) {
				trailingSilenceSeconds += frameDurationSeconds;
			} else {
				endpointState = "in_speech";
				trailingSilenceSeconds = 0;
			}

			if (
				elapsedSeconds >= resolved.minSeconds &&
				trailingSilenceSeconds >= resolved.silenceSeconds
			) {
				stopReason = "trailing_silence";
				requestStop();
				return;
			}
		}

		if (elapsedSeconds >= resolved.maxSeconds) {
			stopReason = "max_seconds";
			requestStop();
		}
	};

	child.stdout.on("data", (chunk: Buffer | string) => {
		const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		rawChunks.push(bufferChunk);
		pendingFrameBytes = Buffer.concat([pendingFrameBytes, bufferChunk]);

		while (pendingFrameBytes.length >= frameBytes) {
			const frame = pendingFrameBytes.subarray(0, frameBytes);
			pendingFrameBytes = pendingFrameBytes.subarray(frameBytes);
			processQueue = processQueue.then(() => processFrame(frame));
		}
	});

	child.on("error", (err) => {
		spawnError = err;
		requestStop();
	});

	child.stderr?.on("data", (chunk: Buffer | string) => {
		const text = (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString();
		if (!text) return;
		stderrTail = `${stderrTail}${text}`;
		if (stderrTail.length > MAX_REC_STDERR_CAPTURE_CHARS) {
			stderrTail = stderrTail.slice(-MAX_REC_STDERR_CAPTURE_CHARS);
		}
	});

	const closeResult = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("close", (code, signal) => {
			resolve({ code, signal });
		});
	});

	const closeInfo = await closeResult;
	await processQueue;
	if (stopPromise) await stopPromise;

	if (spawnError) {
		throw new AudioRecordError("RECORD_FAILED", "rec process failed to start or crashed.", {
			cause: spawnError,
		});
	}

	if (processFatalError) {
		throw processFatalError instanceof AudioRecordError ?
			processFatalError :
			new AudioRecordError("RECORD_FAILED", "Adaptive recording failed.", {
				cause: processFatalError,
			});
	}

	if (closeInfo.code !== null && closeInfo.code !== 0) {
		throw new AudioRecordError(
			"RECORD_FAILED",
			`rec exited with code ${closeInfo.code}${formatRecStderrDetails(stderrTail)}.`,
		);
	}

	if (closeInfo.signal !== null) {
		const expectedSignal = closeInfo.signal === "SIGTERM" || closeInfo.signal === "SIGKILL";
		if (!stopRequested || !expectedSignal) {
			throw new AudioRecordError(
				"RECORD_FAILED",
				`rec exited unexpectedly with signal ${closeInfo.signal}${formatRecStderrDetails(stderrTail)}.`,
			);
		}
	}

	if (!stopReason) {
		throw new AudioRecordError("RECORD_FAILED", "Adaptive recording ended before a stop condition was met.");
	}

	const rawPcm = Buffer.concat(rawChunks);
	const wavBuffer = encodePcm16MonoWav(rawPcm, resolved.sampleRate);
	try {
		await writeFile(outFile, wavBuffer);
	} catch (err) {
		throw new AudioRecordError("WRITE_FAILED", `Failed to write recorded audio file: ${outFile}`, {
			cause: err,
		});
	}

	return {
		stopReason,
		durationSeconds: rawPcm.length / (PCM_BYTES_PER_SAMPLE * resolved.sampleRate),
	};
}

export async function playAudio(file: string): Promise<void> {
	await run("play", ["-q", file]);
}

interface CueToneOptions {
	durationSeconds: number;
	frequencyHz: number;
	gainDb: number;
	fadeInSeconds: number;
	fadeOutSeconds: number;
}

async function playCueTone(options: CueToneOptions): Promise<void> {
	const duration = options.durationSeconds.toFixed(3);
	await run("play", [
		"-q",
		"-n",
		"synth",
		duration,
		"sine",
		String(options.frequencyHz),
		"gain",
		String(options.gainDb),
		"fade",
		"q",
		options.fadeInSeconds.toFixed(3),
		duration,
		options.fadeOutSeconds.toFixed(3),
	]);
}

export async function playInputStartCue(): Promise<void> {
	// Softened start cue: shorter, lower gain, and shaped with a quick envelope.
	await playCueTone({
		durationSeconds: 0.14,
		frequencyHz: 720,
		gainDb: -14,
		fadeInSeconds: 0.006,
		fadeOutSeconds: 0.055,
	});
}

export async function playConversationClosedCue(): Promise<void> {
	// Two-note descending close cue so follow-up window end is audible but unobtrusive.
	await playCueTone({
		durationSeconds: 0.08,
		frequencyHz: 620,
		gainDb: -15,
		fadeInSeconds: 0.005,
		fadeOutSeconds: 0.03,
	});
	await playCueTone({
		durationSeconds: 0.12,
		frequencyHz: 460,
		gainDb: -16,
		fadeInSeconds: 0.005,
		fadeOutSeconds: 0.05,
	});
}

export async function beep(): Promise<void> {
	await playInputStartCue();
}

interface ResolvedAdaptiveRecordConfig {
	minSeconds: number;
	maxSeconds: number;
	silenceSeconds: number;
	noSpeechTimeoutSeconds: number;
	startThreshold: number;
	endThreshold: number;
	frameSamples: number;
	sampleRate: number;
	stopGraceMs: number;
}

async function createVadSession(
	config: AdaptiveRecordConfig,
	resolved: ResolvedAdaptiveRecordConfig,
): Promise<VadSession> {
	return createSileroVadSession({
		modelPath: config.modelPath,
		dataDir: config.dataDir,
		frameSamples: resolved.frameSamples,
		sampleRate: resolved.sampleRate,
	});
}

function resolveAdaptiveRecordConfig(config: AdaptiveRecordConfig): ResolvedAdaptiveRecordConfig {
	const minSeconds = resolvePositiveNumber(config.minSeconds, DEFAULT_MIN_SECONDS, "minSeconds");
	const maxSeconds = resolvePositiveNumber(config.maxSeconds, DEFAULT_MAX_SECONDS, "maxSeconds");
	const silenceSeconds = resolvePositiveNumber(
		config.silenceSeconds,
		DEFAULT_SILENCE_SECONDS,
		"silenceSeconds",
	);
	const noSpeechTimeoutSeconds = resolvePositiveNumber(
		config.noSpeechTimeoutSeconds,
		DEFAULT_NO_SPEECH_TIMEOUT_SECONDS,
		"noSpeechTimeoutSeconds",
	);
	const startThreshold = resolveProbability(config.startThreshold, DEFAULT_START_THRESHOLD, "startThreshold");
	const endThreshold = resolveProbability(config.endThreshold, DEFAULT_END_THRESHOLD, "endThreshold");
	const frameSamples = resolvePositiveInteger(config.frameSamples, DEFAULT_FRAME_SAMPLES, "frameSamples");
	const sampleRate = resolvePositiveInteger(config.sampleRate, DEFAULT_SAMPLE_RATE, "sampleRate");
	const stopGraceMs = resolvePositiveInteger(config.stopGraceMs, DEFAULT_STOP_GRACE_MS, "stopGraceMs");

	if (minSeconds > maxSeconds) {
		throw new AudioRecordError(
			"CONFIG_INVALID",
			`Invalid adaptive recording config: minSeconds (${minSeconds}) must be <= maxSeconds (${maxSeconds}).`,
		);
	}
	if (endThreshold > startThreshold) {
		throw new AudioRecordError(
			"CONFIG_INVALID",
			`Invalid adaptive recording config: endThreshold (${endThreshold}) must be <= startThreshold (${startThreshold}).`,
		);
	}

	return {
		minSeconds,
		maxSeconds,
		silenceSeconds,
		noSpeechTimeoutSeconds,
		startThreshold,
		endThreshold,
		frameSamples,
		sampleRate,
		stopGraceMs,
	};
}

function resolvePositiveNumber(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	if (!Number.isFinite(raw) || raw <= 0) {
		throw new AudioRecordError(
			"CONFIG_INVALID",
			`Invalid adaptive recording config: ${field} must be a positive finite number.`,
		);
	}
	return raw;
}

function resolvePositiveInteger(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	if (!Number.isInteger(raw) || raw <= 0) {
		throw new AudioRecordError(
			"CONFIG_INVALID",
			`Invalid adaptive recording config: ${field} must be a positive integer.`,
		);
	}
	return raw;
}

function resolveProbability(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
		throw new AudioRecordError(
			"CONFIG_INVALID",
			`Invalid adaptive recording config: ${field} must be in range [0, 1].`,
		);
	}
	return raw;
}

function pcm16MonoToFloat32(buffer: Buffer): Float32Array {
	const sampleCount = Math.floor(buffer.length / PCM_BYTES_PER_SAMPLE);
	const frame = new Float32Array(sampleCount);
	for (let i = 0; i < sampleCount; i += 1) {
		const sample = buffer.readInt16LE(i * PCM_BYTES_PER_SAMPLE);
		frame[i] = sample / 32768;
	}
	return frame;
}

function encodePcm16MonoWav(pcmData: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcmData.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // fmt chunk length
	header.writeUInt16LE(1, 20); // PCM format
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * PCM_BYTES_PER_SAMPLE, 28);
	header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcmData.length, 40);
	return Buffer.concat([header, pcmData]);
}

async function terminateProcess(child: ReturnType<typeof spawn>, stopGraceMs: number): Promise<void> {
	if (child.exitCode !== null) return;

	const exited = waitForExit(child);
	child.kill("SIGTERM");
	const exitedBeforeGrace = await Promise.race([
		exited.then(() => true),
		sleep(stopGraceMs).then(() => false),
	]);
	if (exitedBeforeGrace) return;

	if (child.exitCode === null) {
		child.kill("SIGKILL");
	}
	await exited;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();

	return new Promise((resolve) => {
		child.once("close", () => {
			resolve();
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function formatRecStderrDetails(stderrText: string): string {
	const compact = stderrText.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return ` (stderr: ${compact})`;
}

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
	transcribeFileToDocument,
	type TranscribeDocumentFormat,
	type TranscribeDocumentResult,
} from "./document.js";
import { SttError, type SttLanguage, transcribeWav } from "./transcribe.js";

const DEFAULT_OUTPUT_NAME = "mic-listen";
const DEFAULT_LIVE_CHUNK_SECONDS = 30;
const DEFAULT_LIVE_CONTEXT_SECONDS = 1.5;
const FILE_POLL_INTERVAL_MS = 250;
const PCM16_BYTES_PER_SAMPLE = 2;
type MicrophoneStopMode = "duration" | "until_stopped";

export interface TranscribeMicrophoneToDocumentOptions {
	durationSeconds?: number;
	untilStopped?: boolean;
	chunkSeconds?: number;
	language?: SttLanguage;
	format?: TranscribeDocumentFormat;
	outputPath?: string;
	outputDir?: string;
	outputName?: string;
	audioPath?: string;
	audioDir?: string;
	workingDir?: string;
}

export interface TranscribeMicrophoneToDocumentResult extends TranscribeDocumentResult {
	audioPath: string;
	recordedSeconds?: number;
	stopMode: MicrophoneStopMode;
	chunkCount?: number;
}

interface RollingTranscriptRequest {
	durationSeconds?: number;
	stopMode: MicrophoneStopMode;
	chunkSeconds?: number;
	liveOutput: boolean;
}

interface RollingTranscriptFileParams {
	outputPath: string;
	format: TranscribeDocumentFormat;
	requestedLanguage: SttLanguage;
	generatedAt: Date;
	chunkSeconds: number;
	stopMode: MicrophoneStopMode;
	chunkCount: number;
	transcriptText: string;
	lastUpdatedAt?: Date;
	detectedLanguage?: string;
	contextSeconds: number;
}

interface PreparedRollingChunk {
	transcriptionPath: string;
	currentDurationMs: number;
	cleanupPath?: string;
}

interface WavPcm16MonoData {
	sampleRate: number;
	pcmData: Buffer;
}

export async function transcribeMicrophoneToDocument(
	options: TranscribeMicrophoneToDocumentOptions,
): Promise<TranscribeMicrophoneToDocumentResult> {
	const workingDir = resolve(options.workingDir ?? process.cwd());
	const recordingRequest = resolveRecordingRequest(options);
	const format = options.format ?? "txt";
	const outputName = options.outputName?.trim() || DEFAULT_OUTPUT_NAME;
	const generatedAt = new Date();
	const outputPath = resolveTranscriptOutputPath({
		workingDir,
		outputPath: options.outputPath,
		outputDir: options.outputDir,
		outputName,
		format,
		generatedAt,
	});

	if (recordingRequest.liveOutput) {
		return await transcribeMicrophoneRollingToDocument({
			workingDir,
			recordingRequest,
			options,
			format,
			outputName,
			generatedAt,
			outputPath,
		});
	}

	const audioPath = resolveAudioPath({
		workingDir,
		audioPath: options.audioPath,
		audioDir: options.audioDir,
		outputName,
		generatedAt,
	});

	try {
		await mkdir(dirname(audioPath), { recursive: true });
		await recordMicrophoneWav(audioPath, recordingRequest);
	} catch (err) {
		const details = err instanceof Error ? err.message : String(err);
		throw new SttError("TRANSCRIBE_FAILED", `Microphone recording failed: ${details}`, {
			cause: err,
		});
	}

	const transcript = await transcribeFileToDocument({
		inputPath: audioPath,
		language: options.language,
		format,
		outputPath,
		outputDir: options.outputDir,
		outputName,
		workingDir,
	});

	return {
		...transcript,
		audioPath,
		recordedSeconds: recordingRequest.durationSeconds,
		stopMode: recordingRequest.stopMode,
	};
}

function resolveRecordingRequest(options: TranscribeMicrophoneToDocumentOptions): RollingTranscriptRequest {
	const chunkSeconds = resolveChunkSeconds(options.chunkSeconds);
	if (options.untilStopped) {
		if (options.durationSeconds !== undefined) {
			throw new SttError(
				"TRANSCRIBE_FAILED",
				"Provide microphone capture either as a duration or with untilStopped, not both.",
			);
		}
		return {
			stopMode: "until_stopped",
			chunkSeconds: chunkSeconds ?? DEFAULT_LIVE_CHUNK_SECONDS,
			liveOutput: true,
		};
	}

	const durationSeconds = resolveDurationSeconds(options.durationSeconds);
	return {
		durationSeconds,
		stopMode: "duration",
		chunkSeconds,
		liveOutput: chunkSeconds !== undefined,
	};
}

function resolveDurationSeconds(rawDuration: number | undefined): number {
	if (!Number.isFinite(rawDuration) || rawDuration === undefined || rawDuration <= 0) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Invalid microphone duration "${String(rawDuration)}". Expected a positive number of seconds.`,
		);
	}
	return rawDuration;
}

function resolveChunkSeconds(rawChunkSeconds: number | undefined): number | undefined {
	if (rawChunkSeconds === undefined) return undefined;
	if (!Number.isFinite(rawChunkSeconds) || rawChunkSeconds <= 0) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Invalid microphone chunk length "${String(rawChunkSeconds)}". Expected a positive number of seconds.`,
		);
	}
	return rawChunkSeconds;
}

function resolveAudioPath(params: {
	workingDir: string;
	audioPath: string | undefined;
	audioDir: string | undefined;
	outputName: string;
	generatedAt: Date;
}): string {
	if (params.audioPath) return resolve(params.workingDir, params.audioPath);

	const baseDir =
		params.audioDir ?
			resolve(params.workingDir, params.audioDir)
		:	join(params.workingDir, "data", "audio");
	const stem = sanitizeBaseName(params.outputName);
	return join(baseDir, `${stem}-${fileTimestamp(params.generatedAt)}.wav`);
}

function resolveRollingAudioPathPattern(params: {
	workingDir: string;
	audioPath: string | undefined;
	audioDir: string | undefined;
	outputName: string;
	generatedAt: Date;
}): string {
	const basePath = params.audioPath ?
		resolve(params.workingDir, params.audioPath)
	: resolveAudioPath({
			workingDir: params.workingDir,
			audioPath: undefined,
			audioDir: params.audioDir,
			outputName: params.outputName,
			generatedAt: params.generatedAt,
		});
	return ensureSequencePattern(basePath);
}

function ensureSequencePattern(filePath: string): string {
	if (/%\d*n/.test(filePath)) return filePath;
	const extension = extname(filePath);
	if (!extension) return `${filePath}-%4n`;
	return `${filePath.slice(0, -extension.length)}-%4n${extension}`;
}

function resolveTranscriptOutputPath(params: {
	workingDir: string;
	outputPath: string | undefined;
	outputDir: string | undefined;
	outputName: string;
	format: TranscribeDocumentFormat;
	generatedAt: Date;
}): string {
	if (params.outputPath) return resolve(params.workingDir, params.outputPath);
	const baseDir =
		params.outputDir ?
			resolve(params.workingDir, params.outputDir)
		:	join(params.workingDir, "data", "transcribes");
	const stem = sanitizeBaseName(params.outputName);
	return join(baseDir, `${stem}-${fileTimestamp(params.generatedAt)}.${params.format}`);
}

function sanitizeBaseName(name: string): string {
	const rawStem = basename(name, extname(name));
	const sanitized = rawStem
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || DEFAULT_OUTPUT_NAME;
}

function fileTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function transcribeMicrophoneRollingToDocument(params: {
	workingDir: string;
	recordingRequest: RollingTranscriptRequest;
	options: TranscribeMicrophoneToDocumentOptions;
	format: TranscribeDocumentFormat;
	outputName: string;
	generatedAt: Date;
	outputPath: string;
}): Promise<TranscribeMicrophoneToDocumentResult> {
	const audioPath = resolveRollingAudioPathPattern({
		workingDir: params.workingDir,
		audioPath: params.options.audioPath,
		audioDir: params.options.audioDir,
		outputName: params.outputName,
		generatedAt: params.generatedAt,
	});
	const chunkSeconds = params.recordingRequest.chunkSeconds ?? DEFAULT_LIVE_CHUNK_SECONDS;
	await mkdir(dirname(audioPath), { recursive: true });
	await mkdir(dirname(params.outputPath), { recursive: true });
	await writeRollingTranscriptFile({
		outputPath: params.outputPath,
		format: params.format,
		requestedLanguage: params.options.language ?? "auto",
		generatedAt: params.generatedAt,
		chunkSeconds,
		stopMode: params.recordingRequest.stopMode,
		chunkCount: 0,
		transcriptText: "",
		contextSeconds: DEFAULT_LIVE_CONTEXT_SECONDS,
	});

	const recorder = startRollingMicrophoneRecording({
		audioPathPattern: audioPath,
		chunkSeconds,
		stopMode: params.recordingRequest.stopMode,
		totalDurationSeconds: params.recordingRequest.durationSeconds,
	});

	let combinedText = "";
	let combinedLanguage: string = params.options.language ?? "auto";
	let combinedDurationMs = 0;
	let chunkCount = 0;
	let nextChunkIndex = 1;
	let previousChunkPath: string | undefined;

	try {
		while (true) {
			const chunkPath = await waitForReadyChunk({
				audioPathPattern: audioPath,
				chunkIndex: nextChunkIndex,
				recorderState: recorder.state,
			});
			if (!chunkPath) break;

			const preparedChunk = await prepareRollingChunkForTranscription({
				currentChunkPath: chunkPath,
				previousChunkPath,
				contextSeconds: DEFAULT_LIVE_CONTEXT_SECONDS,
			});
			try {
				const transcribed = await transcribeWav(preparedChunk.transcriptionPath, {
					language: params.options.language,
				});
				chunkCount += 1;
				combinedDurationMs += preparedChunk.currentDurationMs;
				combinedLanguage = transcribed.language;
				combinedText = mergeRollingTranscriptText(combinedText, transcribed.text);

				await writeRollingTranscriptFile({
					outputPath: params.outputPath,
					format: params.format,
					requestedLanguage: params.options.language ?? "auto",
					generatedAt: params.generatedAt,
					chunkSeconds,
					stopMode: params.recordingRequest.stopMode,
					chunkCount,
					transcriptText: combinedText,
					lastUpdatedAt: new Date(),
					detectedLanguage: combinedLanguage,
					contextSeconds: DEFAULT_LIVE_CONTEXT_SECONDS,
				});
			} finally {
				await cleanupPreparedRollingChunk(preparedChunk);
			}

			previousChunkPath = chunkPath;
			nextChunkIndex += 1;
		}

		await recorder.finished;
		if (recorder.state.error) {
			throw recorder.state.error;
		}
	} catch (err) {
		await recorder.finished;
		throw err;
	}

	return {
		outputPath: params.outputPath,
		text: combinedText,
		language: combinedLanguage,
		durationMs: combinedDurationMs,
		format: params.format,
		audioPath,
		recordedSeconds: params.recordingRequest.durationSeconds,
		stopMode: params.recordingRequest.stopMode,
		chunkCount,
	};
}

async function writeRollingTranscriptFile(params: RollingTranscriptFileParams): Promise<void> {
	const content =
		params.format === "txt" ?
			renderRollingTextTranscript(params.transcriptText)
		:	renderRollingMarkdownTranscript(params);
	await writeFile(params.outputPath, content, "utf8");
}

function renderRollingTextTranscript(transcriptText: string): string {
	const trimmed = transcriptText.trim();
	return trimmed ? `${trimmed}\n` : "";
}

function renderRollingMarkdownTranscript(params: RollingTranscriptFileParams): string {
	const lines = [
		"# Live Transcript",
		"",
		`- Language mode requested: \`${params.requestedLanguage}\``,
		`- Chunk length: \`${params.chunkSeconds}\` seconds`,
		`- Context overlap: \`${params.contextSeconds}\` seconds`,
		`- Stop mode: \`${params.stopMode}\``,
		`- Generated timestamp: \`${params.generatedAt.toISOString()}\``,
		`- Processed chunks: \`${params.chunkCount}\``,
	];
	if (params.detectedLanguage) {
		lines.push(`- Latest detected language: \`${params.detectedLanguage}\``);
	}
	if (params.lastUpdatedAt) {
		lines.push(`- Last updated: \`${params.lastUpdatedAt.toISOString()}\``);
	}
	lines.push("", "## Transcript", "", params.transcriptText || "_Waiting for transcription..._", "");
	return lines.join("\n");
}

async function prepareRollingChunkForTranscription(params: {
	currentChunkPath: string;
	previousChunkPath: string | undefined;
	contextSeconds: number;
}): Promise<PreparedRollingChunk> {
	const currentAudio = await readWavPcm16Mono(params.currentChunkPath);
	const currentDurationMs = pcmDurationMs(currentAudio.pcmData.length, currentAudio.sampleRate);

	if (!params.previousChunkPath) {
		return {
			transcriptionPath: params.currentChunkPath,
			currentDurationMs,
		};
	}

	const previousAudio = await readWavPcm16Mono(params.previousChunkPath);
	if (previousAudio.sampleRate !== currentAudio.sampleRate) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Rolling microphone chunks use mismatched sample rates (${previousAudio.sampleRate}Hz and ${currentAudio.sampleRate}Hz).`,
		);
	}

	const overlapPcm = sliceTrailingPcm(previousAudio.pcmData, previousAudio.sampleRate, params.contextSeconds);
	if (overlapPcm.length === 0) {
		return {
			transcriptionPath: params.currentChunkPath,
			currentDurationMs,
		};
	}

	const contextualPath = appendStemSuffix(params.currentChunkPath, "-context");
	const contextualPcm = Buffer.concat([overlapPcm, currentAudio.pcmData]);
	await writeMonoPcm16Wav(contextualPath, contextualPcm, currentAudio.sampleRate);
	return {
		transcriptionPath: contextualPath,
		currentDurationMs,
		cleanupPath: contextualPath,
	};
}

async function cleanupPreparedRollingChunk(chunk: PreparedRollingChunk): Promise<void> {
	if (!chunk.cleanupPath) return;
	try {
		await unlink(chunk.cleanupPath);
	} catch {
		// Ignore cleanup failures so the main transcription result still lands.
	}
}

async function readWavPcm16Mono(filePath: string): Promise<WavPcm16MonoData> {
	const data = await readFile(filePath);
	if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Unsupported microphone chunk format for ${filePath}. Expected RIFF/WAVE audio.`,
		);
	}

	let sampleRate: number | undefined;
	let audioFormat: number | undefined;
	let numChannels: number | undefined;
	let bitsPerSample: number | undefined;
	let pcmData: Buffer | undefined;
	let offset = 12;

	while (offset + 8 <= data.length) {
		const chunkId = data.toString("ascii", offset, offset + 4);
		const chunkSize = data.readUInt32LE(offset + 4);
		const chunkStart = offset + 8;
		const chunkEnd = chunkStart + chunkSize;
		if (chunkEnd > data.length) {
			throw new SttError(
				"TRANSCRIBE_FAILED",
				`Corrupt microphone chunk ${filePath}. WAV chunk ${chunkId} extends past the file boundary.`,
			);
		}

		if (chunkId === "fmt ") {
			audioFormat = data.readUInt16LE(chunkStart);
			numChannels = data.readUInt16LE(chunkStart + 2);
			sampleRate = data.readUInt32LE(chunkStart + 4);
			bitsPerSample = data.readUInt16LE(chunkStart + 14);
		}

		if (chunkId === "data") {
			pcmData = Buffer.from(data.subarray(chunkStart, chunkEnd));
		}

		offset = chunkEnd + (chunkSize % 2);
	}

	if (
		audioFormat === undefined ||
		numChannels === undefined ||
		sampleRate === undefined ||
		bitsPerSample === undefined ||
		pcmData === undefined
	) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Incomplete WAV metadata in microphone chunk ${filePath}.`,
		);
	}

	if (audioFormat !== 1 || numChannels !== 1 || bitsPerSample !== 16) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Unsupported microphone chunk format in ${filePath}. Expected PCM16 mono WAV audio.`,
		);
	}

	return {
		sampleRate,
		pcmData,
	};
}

async function writeMonoPcm16Wav(filePath: string, pcmData: Buffer, sampleRate: number): Promise<void> {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcmData.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * PCM16_BYTES_PER_SAMPLE, 28);
	header.writeUInt16LE(PCM16_BYTES_PER_SAMPLE, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcmData.length, 40);
	await writeFile(filePath, Buffer.concat([header, pcmData]));
}

function pcmDurationMs(pcmByteLength: number, sampleRate: number): number {
	return Math.round((pcmByteLength / PCM16_BYTES_PER_SAMPLE / sampleRate) * 1000);
}

function sliceTrailingPcm(pcmData: Buffer, sampleRate: number, seconds: number): Buffer {
	const sampleCount = Math.max(0, Math.ceil(sampleRate * seconds));
	const byteCount = Math.min(pcmData.length, sampleCount * PCM16_BYTES_PER_SAMPLE);
	if (byteCount <= 0) return Buffer.alloc(0);
	return Buffer.from(pcmData.subarray(pcmData.length - byteCount));
}

function appendStemSuffix(filePath: string, suffix: string): string {
	const extension = extname(filePath);
	if (!extension) return `${filePath}${suffix}`;
	return `${filePath.slice(0, -extension.length)}${suffix}${extension}`;
}

function mergeRollingTranscriptText(existingText: string, incomingText: string): string {
	const existing = existingText.trim();
	const incoming = incomingText.trim();
	if (!existing) return incoming;
	if (!incoming) return existing;

	const overlap = findNormalizedOverlap(existing, incoming);
	if (overlap !== null && isMeaningfulNormalizedOverlap(overlap.normalizedLength, overlap.normalizedText)) {
		const rawSuffix = incoming.slice(overlap.incomingSliceStart);
		if (!rawSuffix.trim()) return existing;
		return `${existing}${rawSuffix}`;
	}

	return joinTranscriptSegments(existing, incoming);
}

function joinTranscriptSegments(existing: string, incoming: string): string {
	if (!existing) return incoming;
	if (!incoming) return existing;
	if (startsWithPunctuation(incoming) || endsWithWhitespace(existing)) {
		return `${existing}${incoming}`;
	}
	return `${existing}${needsJoiner(existing, incoming) ? " " : ""}${incoming}`;
}

function needsJoiner(left: string, right: string): boolean {
	const leftChar = left.at(-1);
	const rightChar = right.at(0);
	if (!leftChar || !rightChar) return false;
	return isWordCharacter(leftChar) && isWordCharacter(rightChar);
}

function startsWithPunctuation(value: string): boolean {
	const first = value.at(0);
	if (!first) return false;
	return /[.,!?;:)\]]/.test(first);
}

function endsWithWhitespace(value: string): boolean {
	return /\s$/.test(value);
}

function isMeaningfulNormalizedOverlap(length: number, text: string): boolean {
	return length >= 4 || text.includes(" ");
}

function findNormalizedOverlap(existingText: string, incomingText: string): {
	normalizedLength: number;
	normalizedText: string;
	incomingSliceStart: number;
} | null {
	const existingView = normalizeTextForMerge(existingText);
	const incomingView = normalizeTextForMerge(incomingText);
	if (!existingView.normalized || !incomingView.normalized) return null;

	const maxLength = Math.min(existingView.normalized.length, incomingView.normalized.length);
	for (let length = maxLength; length >= 1; length -= 1) {
		if (existingView.normalized.slice(-length) !== incomingView.normalized.slice(0, length)) continue;
		const incomingSliceStart = incomingView.boundaries[length] ?? incomingText.length;
		return {
			normalizedLength: length,
			normalizedText: incomingView.normalized.slice(0, length),
			incomingSliceStart,
		};
	}
	return null;
}

function normalizeTextForMerge(value: string): {
	normalized: string;
	boundaries: number[];
} {
	let normalized = "";
	let pendingSpace = false;
	const boundaries = [0];

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (isWordCharacter(char)) {
			if (pendingSpace && normalized.length > 0 && normalized.at(-1) !== " ") {
				normalized += " ";
				boundaries[normalized.length] = index;
			}
			pendingSpace = false;
			normalized += char.toLocaleLowerCase();
			boundaries[normalized.length] = index + 1;
			continue;
		}
		if (/\s/u.test(char) || /[.,!?;:'"()[\]{}\-_/\\]/u.test(char)) {
			pendingSpace = normalized.length > 0;
		}
	}

	return { normalized, boundaries };
}

function isWordCharacter(char: string): boolean {
	return /[\p{L}\p{N}]/u.test(char);
}

function startRollingMicrophoneRecording(params: {
	audioPathPattern: string;
	chunkSeconds: number;
	stopMode: MicrophoneStopMode;
	totalDurationSeconds?: number;
	sampleRate?: number;
}): {
	state: { finished: boolean; error?: unknown };
	finished: Promise<void>;
} {
	const sampleRate = params.sampleRate ?? 16000;
	const state: { finished: boolean; error?: unknown } = { finished: false };
	let stderr = "";
	let stopRequested = false;
	let expectedStop = false;
	const onSigint = () => requestStop("SIGINT");
	const onSigterm = () => requestStop("SIGTERM");
	const child = spawn("rec", [
		"-q",
		"-c",
		"1",
		"-r",
		String(sampleRate),
		"-b",
		"16",
		"-e",
		"signed-integer",
		"-t",
		"wavpcm",
		params.audioPathPattern,
		"trim",
		"0",
		String(params.chunkSeconds),
		":",
		"newfile",
		":",
		"restart",
	]);

	if (params.stopMode === "until_stopped") {
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
	}

	function cleanupSignalHandlers() {
		if (params.stopMode !== "until_stopped") return;
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
	}

	function requestStop(signal: NodeJS.Signals, expected = true) {
		if (stopRequested) return;
		stopRequested = true;
		expectedStop = expected;
		child.kill(signal);
	}

	const autoStopTimer =
		params.stopMode === "duration" && params.totalDurationSeconds !== undefined ?
			setTimeout(() => {
				requestStop("SIGTERM");
			}, params.totalDurationSeconds * 1000)
		:	null;

	child.stderr?.on("data", (chunk: Buffer | string) => {
		stderr += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString();
	});

	const finished = new Promise<void>((resolvePromise) => {
		child.on("error", (err) => {
			state.finished = true;
			state.error = err;
			if (autoStopTimer) clearTimeout(autoStopTimer);
			cleanupSignalHandlers();
			resolvePromise();
		});
		child.on("exit", (code) => {
			state.finished = true;
			if (autoStopTimer) clearTimeout(autoStopTimer);
			cleanupSignalHandlers();
			if (code === 0) {
				resolvePromise();
				return;
			}
			if (expectedStop && stopRequested) {
				resolvePromise();
				return;
			}
			const detail = stderr.trim();
			state.error = new Error(
				detail ? `rec exited with code ${code}: ${detail}` : `rec exited with code ${code}`,
			);
			resolvePromise();
		});
	});

	return {
		state,
		finished,
	};
}

async function waitForReadyChunk(params: {
	audioPathPattern: string;
	chunkIndex: number;
	recorderState: { finished: boolean };
}): Promise<string | null> {
	const currentChunkPath = resolveChunkPath(params.audioPathPattern, params.chunkIndex);
	const nextChunkPath = resolveChunkPath(params.audioPathPattern, params.chunkIndex + 1);

	while (true) {
		const currentExists = await fileExists(currentChunkPath);
		const nextExists = await fileExists(nextChunkPath);
		if (currentExists && (nextExists || params.recorderState.finished)) {
			return currentChunkPath;
		}
		if (params.recorderState.finished && !currentExists) return null;
		await sleep(FILE_POLL_INTERVAL_MS);
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveChunkPath(audioPathPattern: string, chunkIndex: number): string {
	const match = audioPathPattern.match(/%(\d*)n/);
	if (!match) return audioPathPattern;
	const width = match[1] ? Number.parseInt(match[1], 10) : 1;
	const replacement = String(chunkIndex).padStart(Number.isFinite(width) ? width : 1, "0");
	return audioPathPattern.replace(/%\d*n/, replacement);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function recordMicrophoneWav(
	outFile: string,
	request: { durationSeconds?: number; stopMode: MicrophoneStopMode },
	sampleRate = 16000,
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		let stderr = "";
		let stopRequested = false;
		const onSigint = () => requestStop("SIGINT");
		const onSigterm = () => requestStop("SIGTERM");
		const args = ["-q", "-c", "1", outFile, "rate", "-v", String(sampleRate)];
		if (request.stopMode === "duration") {
			args.splice(4, 0, "trim", "0", String(request.durationSeconds));
		}
		const child = spawn("rec", args);

		if (request.stopMode === "until_stopped") {
			process.once("SIGINT", onSigint);
			process.once("SIGTERM", onSigterm);
		}

		function cleanupSignalHandlers() {
			if (request.stopMode !== "until_stopped") return;
			process.removeListener("SIGINT", onSigint);
			process.removeListener("SIGTERM", onSigterm);
		}

		function requestStop(signal: NodeJS.Signals) {
			if (stopRequested) return;
			stopRequested = true;
			child.kill(signal);
		}

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString();
		});
		child.on("error", (err) => {
			cleanupSignalHandlers();
			reject(err);
		});
		child.on("exit", (code) => {
			cleanupSignalHandlers();
			if (code === 0) {
				resolvePromise();
				return;
			}
			if (request.stopMode === "until_stopped" && stopRequested) {
				resolvePromise();
				return;
			}
			const detail = stderr.trim();
			reject(
				new Error(
					detail ? `rec exited with code ${code}: ${detail}` : `rec exited with code ${code}`,
				),
			);
		});
	});
}

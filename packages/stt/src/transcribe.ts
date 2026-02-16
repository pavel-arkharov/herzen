import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

type SttErrorCode =
	| "RUNTIME_MISSING"
	| "MODEL_MISSING"
	| "TRANSCRIBE_FAILED"
	| "OUTPUT_PARSE_FAILED";

export type { SttErrorCode };

export type SttLanguage = "auto" | "en" | "ru";

export interface SttOptions {
	language?: SttLanguage;
	extraArgs?: string[];
}

export interface SttResult {
	text: string;
	language: string;
	backend: "whisper.cpp";
	durationMs: number;
}

interface SttErrorOptions {
	cause?: unknown;
}

export class SttError extends Error {
	readonly code: SttErrorCode;
	declare readonly cause?: unknown;

	constructor(code: SttErrorCode, message: string, options?: SttErrorOptions) {
		super(message);
		this.name = "SttError";
		this.code = code;
		this.cause = options?.cause;
	}
}

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

interface WhisperJson {
	result?: {
		language?: string;
	};
	transcription?: Array<{
		text?: string;
	}>;
	text?: string;
}

const BACKEND = "whisper.cpp";
const FALLBACK_BINARIES = ["whisper-cli"] as const;
const WHISPER_DIRECT_INPUT_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac"]);
const AUTO_CONVERT_EXTENSIONS = new Set([".m4a"]);

export async function transcribeWav(filePath: string, options: SttOptions = {}): Promise<SttResult> {
	const start = Date.now();
	const binary = await resolveWhisperBinary();
	const modelPath = await resolveModelPath();
	const languageMode = resolveLanguageMode(options.language);
	const threads = resolveThreads(process.env.HERZEN_STT_THREADS);
	const tempDir = await mkdtemp(join(tmpdir(), "herzen-stt-"));
	const outputPrefix = join(tempDir, "transcript");
	const whisperInputPath = await prepareWhisperInput(filePath, tempDir);

	const args: string[] = [
		"-m",
		modelPath,
		"-f",
		whisperInputPath,
		"-l",
		languageMode,
		"-oj",
		"-of",
		outputPrefix,
	];
	if (threads !== undefined) args.push("-t", String(threads));
	if (options.extraArgs?.length) args.push(...options.extraArgs);

	try {
		const output = await runCommand(binary, args);
		const parsed = await parseTranscript({
			outputPrefix,
			stdout: output.stdout,
			stderr: output.stderr,
			fallbackLanguage: languageMode,
		});
		return {
			text: parsed.text,
			language: parsed.language,
			backend: BACKEND,
			durationMs: Date.now() - start,
		};
	} catch (err) {
		if (err instanceof SttError) throw err;
		const details = err instanceof Error ? err.message : String(err);
		throw new SttError("TRANSCRIBE_FAILED", `whisper.cpp transcription failed: ${details}`, { cause: err });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function resolveLanguageMode(explicitLanguage: SttLanguage | undefined): SttLanguage {
	if (explicitLanguage) return explicitLanguage;

	const fromEnv = process.env.HERZEN_STT_LANGUAGE?.trim();
	if (!fromEnv) return "auto";
	if (fromEnv === "auto" || fromEnv === "en" || fromEnv === "ru") return fromEnv;

	throw new SttError(
		"TRANSCRIBE_FAILED",
		`Unsupported HERZEN_STT_LANGUAGE "${fromEnv}". Expected one of: auto, en, ru.`,
	);
}

function resolveThreads(rawThreads: string | undefined): number | undefined {
	if (!rawThreads?.trim()) return undefined;
	const parsed = Number.parseInt(rawThreads, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Invalid HERZEN_STT_THREADS "${rawThreads}". Expected a positive integer.`,
		);
	}
	return parsed;
}

async function resolveModelPath(): Promise<string> {
	const modelPath = process.env.HERZEN_WHISPER_MODEL?.trim();
	if (!modelPath) {
		throw new SttError(
			"MODEL_MISSING",
			"HERZEN_WHISPER_MODEL is required and must point to a local whisper.cpp model file.",
		);
	}

	try {
		await access(modelPath, constants.F_OK);
	} catch (err) {
		throw new SttError("MODEL_MISSING", `Whisper model file not found: ${modelPath}`, { cause: err });
	}

	return modelPath;
}

async function resolveWhisperBinary(): Promise<string> {
	const envBinary = process.env.HERZEN_WHISPER_BIN?.trim();
	const candidates = dedupe([envBinary, ...FALLBACK_BINARIES]);

	for (const candidate of candidates) {
		const probe = await probeBinary(candidate, candidate === envBinary);
		if (probe === "ok") return candidate;
	}

	throw new SttError(
		"RUNTIME_MISSING",
		"Could not find a whisper.cpp CLI binary. Set HERZEN_WHISPER_BIN or install whisper-cli on PATH.",
	);
}

async function probeBinary(candidate: string, allowWithoutSignature: boolean): Promise<"ok" | "missing"> {
	try {
		const result = await runCommand(candidate, ["--help"], { allowNonZeroExit: true, timeoutMs: 3000 });
		if (result.code === null) return "missing";
		const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
		if (allowWithoutSignature) return "ok";
		if (candidate.toLowerCase().includes("whisper")) return "ok";
		if (basename(candidate).toLowerCase().includes("whisper")) return "ok";
		return text.includes("whisper") ? "ok" : "missing";
	} catch (err) {
		if (isSpawnMissingError(err)) return "missing";
		return "missing";
	}
}

function dedupe(values: Array<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

async function parseTranscript(params: {
	outputPrefix: string;
	stdout: string;
	stderr: string;
	fallbackLanguage: SttLanguage;
}): Promise<{ text: string; language: string }> {
	const jsonPath = `${params.outputPrefix}.json`;
	try {
		const jsonRaw = await readFile(jsonPath, "utf8");
		const payload = JSON.parse(jsonRaw) as WhisperJson;
		const text = collapseWhitespace(parseWhisperJsonText(payload));
		const language = payload.result?.language?.trim() || params.fallbackLanguage;
		return { text, language };
	} catch (err) {
		const fallbackText = parseTranscriptFromCliOutput(params.stdout, params.stderr);
		if (fallbackText) {
			return { text: fallbackText, language: params.fallbackLanguage };
		}
		throw new SttError("OUTPUT_PARSE_FAILED", "Failed to parse whisper.cpp transcription output.", {
			cause: err,
		});
	}
}

async function prepareWhisperInput(inputPath: string, tempDir: string): Promise<string> {
	const extension = extname(inputPath).toLowerCase();
	if (!extension || WHISPER_DIRECT_INPUT_EXTENSIONS.has(extension)) return inputPath;

	if (!AUTO_CONVERT_EXTENSIONS.has(extension)) {
		throw new SttError(
			"TRANSCRIBE_FAILED",
			`Unsupported input format "${extension}". Supported: .wav, .mp3, .ogg, .flac, .m4a.`,
		);
	}

	const convertedPath = join(tempDir, "input.wav");
	await convertM4aToWav(inputPath, convertedPath);
	return convertedPath;
}

async function convertM4aToWav(inputPath: string, outputPath: string): Promise<void> {
	const errors: string[] = [];

	try {
		await runCommand("ffmpeg", [
			"-y",
			"-i",
			inputPath,
			"-ar",
			"16000",
			"-ac",
			"1",
			"-c:a",
			"pcm_s16le",
			outputPath,
		]);
		return;
	} catch (err) {
		errors.push(`ffmpeg: ${formatConversionError(err)}`);
	}

	try {
		await runCommand("afconvert", ["-f", "WAVE", "-d", "LEI16", inputPath, outputPath]);
		return;
	} catch (err) {
		errors.push(`afconvert: ${formatConversionError(err)}`);
	}

	throw new SttError(
		"TRANSCRIBE_FAILED",
		`Failed to transcode .m4a input. Install ffmpeg (brew install ffmpeg) or convert to wav manually. Tried ffmpeg and afconvert. ${errors.join(" | ")}`,
	);
}

function formatConversionError(err: unknown): string {
	if (isSpawnMissingError(err)) return "binary not found";
	if (err instanceof SttError) return err.message;
	return err instanceof Error ? err.message : String(err);
}

function parseWhisperJsonText(payload: WhisperJson): string {
	const segments = payload.transcription
		?.map((segment) => segment.text?.trim())
		.filter((segment): segment is string => Boolean(segment));
	if (segments && segments.length > 0) return segments.join(" ");
	return payload.text?.trim() ?? "";
}

function parseTranscriptFromCliOutput(stdout: string, stderr: string): string {
	const lines = `${stdout}\n${stderr}`
		.split(/\r?\n/)
		.map((line) => stripAnsi(line).trim())
		.filter(Boolean);

	const fromTimestampedLines = lines
		.map((line) => line.match(/^\[[^\]]+-->\s*[^\]]+\]\s*(.+)$/)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
	if (fromTimestampedLines.length > 0) return collapseWhitespace(fromTimestampedLines.join(" "));

	const fromLabeledLines = lines
		.map((line) => line.match(/^transcription:\s*(.+)$/i)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
	if (fromLabeledLines.length > 0) return collapseWhitespace(fromLabeledLines.join(" "));

	return "";
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function stripAnsi(text: string): string {
	const escape = String.fromCharCode(27);
	const ansiPattern = new RegExp(`${escape}\\[[0-9;]*m`, "g");
	return text.replace(ansiPattern, "");
}

function isSpawnMissingError(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function runCommand(
	command: string,
	args: string[],
	options?: { allowNonZeroExit?: boolean; timeoutMs?: number },
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timeout: NodeJS.Timeout | undefined;

		if (options?.timeoutMs) {
			timeout = setTimeout(() => {
				child.kill("SIGKILL");
			}, options.timeoutMs);
		}

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			if (timeout) clearTimeout(timeout);
			reject(err);
		});

		child.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			if (code === 0 || options?.allowNonZeroExit) {
				resolve({ stdout, stderr, code });
				return;
			}

			reject(
				new SttError("TRANSCRIBE_FAILED", `${command} exited with code ${code}.`, {
					cause: stderr || stdout,
				}),
			);
		});
	});
}

import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TTS_PROVIDER: TtsProvider = "say";
const DEFAULT_TTS_FALLBACK_PROVIDER: TtsProvider = "say";
const DEFAULT_XTTS_ENDPOINT = "http://127.0.0.1:8020";
const DEFAULT_XTTS_TIMEOUT_MS = 12_000;
const DEFAULT_XTTS_VOICE_PROFILE = "default";
const PLAY_HEADROOM_GAIN = "0.92";
const PLAY_LEAD_IN_SECONDS = "0.04";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CONNECTION_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
]);

export type TtsLanguage = "en" | "ru";
export type TtsProvider = "say" | "piper" | "xtts";
export type TtsErrorCode =
	| "CONFIG_INVALID"
	| "RUNTIME_UNAVAILABLE"
	| "SYNTH_FAILED"
	| "OUTPUT_INVALID"
	| "PLAYBACK_FAILED";

export type TtsErrorStage = "config" | "request" | "response" | "decode" | "synthesize" | "playback";

interface TtsErrorOptions {
	provider?: TtsProvider;
	stage?: TtsErrorStage;
	cause?: unknown;
}

export class TtsError extends Error {
	readonly code: TtsErrorCode;
	readonly provider?: TtsProvider;
	readonly stage?: TtsErrorStage;
	declare readonly cause?: unknown;

	constructor(code: TtsErrorCode, message: string, options: TtsErrorOptions = {}) {
		super(message);
		this.name = "TtsError";
		this.code = code;
		this.provider = options.provider;
		this.stage = options.stage;
		this.cause = options.cause;
	}
}

interface SpeakRequest {
	text: string;
	language: TtsLanguage;
}

interface XttsConfig {
	endpoint: string;
	timeoutMs: number;
	voiceProfile: string;
}

interface XttsErrorContext {
	endpoint: string;
	timeoutMs: number;
	timedOut: boolean;
}

interface XttsJsonResponse {
	audioBase64: string;
	format?: string;
}

interface PiperConfig {
	modelEn?: string;
	modelRu?: string;
	configEn?: string;
	configRu?: string;
	lengthScale?: number;
	noiseScale?: number;
	noiseW?: number;
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("error", reject);
		p.on("exit", (code) =>
			code === 0 ? resolve() : (
				reject(new Error(`${cmd} exited with code ${code}`))
			),
		);
	});
}

function hasCyrillic(value: string): boolean {
	return /[А-Яа-яЁё]/.test(value);
}

function parseTaggedLanguage(text: string): {
	lang?: TtsLanguage;
	clean: string;
} {
	const match = text.match(/^\s*\[(en|ru)\]\s*/i);
	if (!match) return { clean: text };
	const lang = match[1].toLowerCase() as TtsLanguage;
	return { lang, clean: text.slice(match[0].length) };
}

function pickVoice(lang: TtsLanguage): string | undefined {
	if (lang === "ru") return undefined;
	return undefined;
}

function resolveTtsProvider(rawProvider = process.env.HERZEN_TTS_PROVIDER): TtsProvider {
	const normalized = rawProvider?.trim().toLowerCase();
	if (!normalized) return DEFAULT_TTS_PROVIDER;
	if (normalized === "say" || normalized === "piper" || normalized === "xtts") {
		return normalized;
	}

	throw new TtsError(
		"CONFIG_INVALID",
		`Unsupported HERZEN_TTS_PROVIDER "${rawProvider}". Supported values: say, piper, xtts.`,
		{ stage: "config" },
	);
}

function resolveFallbackProvider(
	rawFallbackProvider = process.env.HERZEN_TTS_FALLBACK_PROVIDER,
): TtsProvider {
	const normalized = rawFallbackProvider?.trim().toLowerCase();
	if (!normalized) return DEFAULT_TTS_FALLBACK_PROVIDER;
	if (normalized === "say" || normalized === "piper" || normalized === "xtts") {
		return normalized;
	}

	throw new TtsError(
		"CONFIG_INVALID",
		`Unsupported HERZEN_TTS_FALLBACK_PROVIDER "${rawFallbackProvider}". Supported values: say, piper, xtts.`,
		{ stage: "config" },
	);
}

function parseBooleanFlag(rawFlag: string | undefined): boolean {
	const normalized = rawFlag?.trim().toLowerCase();
	if (!normalized) return false;
	return TRUE_VALUES.has(normalized);
}

function resolvePositiveInteger(rawValue: string | undefined, fallback: number, envName: string): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new TtsError(
			"CONFIG_INVALID",
			`${envName} must be a positive integer (received "${rawValue}").`,
			{ provider: "xtts", stage: "config" },
		);
	}
	return parsed;
}

function resolveOptionalNumber(
	rawValue: string | undefined,
	envName: string,
	provider: TtsProvider,
): number | undefined {
	const trimmed = rawValue?.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		throw new TtsError(
			"CONFIG_INVALID",
			`${envName} must be a valid number (received "${rawValue}").`,
			{ provider, stage: "config" },
		);
	}
	return parsed;
}

function resolveOptionalPath(rawValue: string | undefined): string | undefined {
	const trimmed = rawValue?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(rawBaseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(rawBaseUrl);
	} catch (err) {
		throw new TtsError(
			"CONFIG_INVALID",
			`Invalid HERZEN_TTS_XTTS_ENDPOINT "${rawBaseUrl}". Expected a valid http(s) URL.`,
			{ provider: "xtts", stage: "config", cause: err },
		);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TtsError(
			"CONFIG_INVALID",
			`Invalid HERZEN_TTS_XTTS_ENDPOINT protocol "${parsed.protocol}". Expected http or https.`,
			{ provider: "xtts", stage: "config" },
		);
	}

	return parsed.toString().replace(/\/$/, "");
}

function isLoopbackUrl(baseUrl: string): boolean {
	const parsed = new URL(baseUrl);
	const hostname = parsed.hostname.toLowerCase();
	if (LOOPBACK_HOSTS.has(hostname)) return true;
	return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function resolvePiperConfig(env: NodeJS.ProcessEnv = process.env): PiperConfig {
	return {
		modelEn: resolveOptionalPath(env.HERZEN_TTS_PIPER_MODEL_EN),
		modelRu: resolveOptionalPath(env.HERZEN_TTS_PIPER_MODEL_RU),
		configEn: resolveOptionalPath(env.HERZEN_TTS_PIPER_CONFIG_EN),
		configRu: resolveOptionalPath(env.HERZEN_TTS_PIPER_CONFIG_RU),
		lengthScale: resolveOptionalNumber(env.HERZEN_TTS_RATE_SCALE, "HERZEN_TTS_RATE_SCALE", "piper"),
		noiseScale: resolveOptionalNumber(env.HERZEN_TTS_NOISE_SCALE, "HERZEN_TTS_NOISE_SCALE", "piper"),
		noiseW: resolveOptionalNumber(env.HERZEN_TTS_NOISE_W, "HERZEN_TTS_NOISE_W", "piper"),
	};
}

function resolvePiperModelConfig(
	config: PiperConfig,
	language: TtsLanguage,
): {
	modelPath: string;
	configPath?: string;
} {
	if (language === "ru") {
		if (!config.modelRu) {
			throw new TtsError(
				"CONFIG_INVALID",
				"HERZEN_TTS_PIPER_MODEL_RU must be set when speaking ru text.",
				{ provider: "piper", stage: "config" },
			);
		}

		return {
			modelPath: config.modelRu,
			configPath: config.configRu,
		};
	}

	if (!config.modelEn) {
		throw new TtsError(
			"CONFIG_INVALID",
			"HERZEN_TTS_PIPER_MODEL_EN must be set when speaking en text.",
			{ provider: "piper", stage: "config" },
		);
	}

	return {
		modelPath: config.modelEn,
		configPath: config.configEn,
	};
}

function resolveXttsConfig(env: NodeJS.ProcessEnv = process.env): XttsConfig {
	const endpointRaw = env.HERZEN_TTS_XTTS_ENDPOINT?.trim() || DEFAULT_XTTS_ENDPOINT;
	const endpoint = normalizeBaseUrl(endpointRaw);

	if (!parseBooleanFlag(env.HERZEN_ALLOW_REMOTE_TTS) && !isLoopbackUrl(endpoint)) {
		throw new TtsError(
			"CONFIG_INVALID",
			`HERZEN_TTS_XTTS_ENDPOINT must use loopback host by default (received "${endpoint}"). Set HERZEN_ALLOW_REMOTE_TTS=1 to override.`,
			{ provider: "xtts", stage: "config" },
		);
	}

	const timeoutMs = resolvePositiveInteger(
		env.HERZEN_TTS_XTTS_TIMEOUT_MS,
		DEFAULT_XTTS_TIMEOUT_MS,
		"HERZEN_TTS_XTTS_TIMEOUT_MS",
	);

	const voiceProfile = env.HERZEN_TTS_XTTS_VOICE_PROFILE?.trim() || DEFAULT_XTTS_VOICE_PROFILE;
	if (!voiceProfile) {
		throw new TtsError(
			"CONFIG_INVALID",
			"HERZEN_TTS_XTTS_VOICE_PROFILE must not be empty.",
			{ provider: "xtts", stage: "config" },
		);
	}

	return {
		endpoint,
		timeoutMs,
		voiceProfile,
	};
}

async function speakWithSay(request: SpeakRequest): Promise<void> {
	const voice = pickVoice(request.language);
	const args: string[] = [];
	if (voice) args.push("-v", voice);
	args.push(request.text);

	await run("say", args);
}

async function speakWithProvider(
	provider: TtsProvider,
	request: SpeakRequest,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	switch (provider) {
		case "say":
			await speakWithSay(request);
			return;
		case "xtts":
			await speakWithXtts(request, env);
			return;
		case "piper":
			await speakWithPiper(request, env);
			return;
		default:
			return assertNever(provider);
	}
}

async function speakWithPiper(request: SpeakRequest, env: NodeJS.ProcessEnv): Promise<void> {
	const config = resolvePiperConfig(env);
	const { modelPath, configPath } = resolvePiperModelConfig(config, request.language);
	const tempDir = await mkdtemp(join(tmpdir(), "herzen-piper-"));
	const tempFile = join(tempDir, "speech.wav");

	try {
		await synthesizeWithPiper(request.text, tempFile, modelPath, configPath, config);
		await ensurePiperOutputFile(tempFile);
		await playWavFile(tempFile, "piper");
	} catch (err) {
		if (err instanceof TtsError) throw err;
		throw new TtsError("SYNTH_FAILED", "Failed to synthesize speech with Piper.", {
			provider: "piper",
			stage: "synthesize",
			cause: err,
		});
	} finally {
		await cleanupTempWav(tempFile, tempDir);
	}
}

async function synthesizeWithPiper(
	text: string,
	outputFile: string,
	modelPath: string,
	configPath: string | undefined,
	config: PiperConfig,
): Promise<void> {
	const args = buildPiperArgs(outputFile, modelPath, configPath, config);
	await runPiperCommand(args, text);
}

function buildPiperArgs(
	outputFile: string,
	modelPath: string,
	configPath: string | undefined,
	config: PiperConfig,
): string[] {
	const args = ["--model", modelPath, "--output_file", outputFile];
	if (configPath) {
		args.push("--config", configPath);
	}
	if (typeof config.lengthScale === "number") {
		args.push("--length_scale", String(config.lengthScale));
	}
	if (typeof config.noiseScale === "number") {
		args.push("--noise_scale", String(config.noiseScale));
	}
	if (typeof config.noiseW === "number") {
		args.push("--noise_w", String(config.noiseW));
	}

	return args;
}

async function runPiperCommand(args: string[], text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settleResolve = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		const settleReject = (err: TtsError) => {
			if (settled) return;
			settled = true;
			reject(err);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("piper", args, { stdio: ["pipe", "ignore", "pipe"] });
		} catch (err) {
			settleReject(
				new TtsError("SYNTH_FAILED", "Failed to start Piper synthesis process.", {
					provider: "piper",
					stage: "synthesize",
					cause: err,
				}),
			);
			return;
		}

		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (stderr.length > 8_000) {
				stderr = stderr.slice(-8_000);
			}
		});

		child.on("error", (err) => {
			if (isCommandNotFound(err)) {
				settleReject(
					new TtsError("RUNTIME_UNAVAILABLE", "Piper binary was not found on PATH.", {
						provider: "piper",
						stage: "synthesize",
						cause: err,
					}),
				);
				return;
			}

			settleReject(
				new TtsError("SYNTH_FAILED", "Failed to start Piper synthesis process.", {
					provider: "piper",
					stage: "synthesize",
					cause: err,
				}),
			);
		});

		child.on("exit", (code, signal) => {
			if (code === 0) {
				settleResolve();
				return;
			}

			const exitReason = code === null ? `signal ${String(signal ?? "unknown")}` : `code ${code}`;
			const stderrMessage = normalizeWhitespace(stderr);
			settleReject(
				new TtsError(
					"SYNTH_FAILED",
					`Piper exited with ${exitReason}${stderrMessage ? `: ${stderrMessage}` : ""}.`,
					{ provider: "piper", stage: "synthesize" },
				),
			);
		});

		child.stdin?.on("error", (err) => {
			settleReject(
				new TtsError("SYNTH_FAILED", "Failed to write text input to Piper process.", {
					provider: "piper",
					stage: "synthesize",
					cause: err,
				}),
			);
		});

		child.stdin?.end(`${text}\n`);
	});
}

async function ensurePiperOutputFile(file: string): Promise<void> {
	let outputStats: Awaited<ReturnType<typeof stat>>;
	try {
		outputStats = await stat(file);
	} catch (err) {
		throw new TtsError("SYNTH_FAILED", `Piper did not produce output audio file: ${file}`, {
			provider: "piper",
			stage: "synthesize",
			cause: err,
		});
	}

	if (outputStats.size <= 0) {
		throw new TtsError("SYNTH_FAILED", `Piper produced an empty output audio file: ${file}`, {
			provider: "piper",
			stage: "synthesize",
		});
	}
}

async function speakWithXtts(request: SpeakRequest, env: NodeJS.ProcessEnv): Promise<void> {
	const config = resolveXttsConfig(env);
	const wavBytes = await synthesizeWithXtts(request, config);
	await playTempWav(wavBytes);
}

async function synthesizeWithXtts(request: SpeakRequest, config: XttsConfig): Promise<Buffer> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, config.timeoutMs);

	let response: Response;
	try {
		response = await fetch(`${config.endpoint}/synthesize`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				text: request.text,
				language: request.language,
				voiceProfile: config.voiceProfile,
			}),
			signal: controller.signal,
		});
	} catch (err) {
		throw mapXttsRequestError(err, {
			endpoint: config.endpoint,
			timeoutMs: config.timeoutMs,
			timedOut,
		});
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		const message = await readErrorMessage(response);
		throw new TtsError(
			"SYNTH_FAILED",
			`XTTS sidecar returned HTTP ${response.status}${message ? `: ${message}` : ""}.`,
			{ provider: "xtts", stage: "response" },
		);
	}

	return decodeXttsAudioResponse(response);
}

async function decodeXttsAudioResponse(response: Response): Promise<Buffer> {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	const isWavBinary =
		contentType.includes("audio/wav") ||
		contentType.includes("audio/x-wav") ||
		contentType.includes("application/octet-stream");

	if (isWavBinary) {
		const audioBuffer = Buffer.from(await response.arrayBuffer());
		if (audioBuffer.length === 0) {
			throw new TtsError("OUTPUT_INVALID", "XTTS sidecar returned empty audio bytes.", {
				provider: "xtts",
				stage: "decode",
			});
		}
		return audioBuffer;
	}

	if (contentType && !contentType.includes("application/json")) {
		throw new TtsError(
			"OUTPUT_INVALID",
			`Unsupported XTTS response content-type "${contentType}". Expected audio/wav or JSON payload.`,
			{ provider: "xtts", stage: "decode" },
		);
	}

	const payload = await parseJsonPayload(response);
	return decodeJsonAudioPayload(payload);
}

async function parseJsonPayload(response: Response): Promise<unknown> {
	const body = await response.text();
	if (!body.trim()) {
		throw new TtsError("OUTPUT_INVALID", "XTTS sidecar returned an empty JSON body.", {
			provider: "xtts",
			stage: "decode",
		});
	}

	try {
		return JSON.parse(body);
	} catch (err) {
		throw new TtsError("OUTPUT_INVALID", "XTTS sidecar returned malformed JSON body.", {
			provider: "xtts",
			stage: "decode",
			cause: err,
		});
	}
}

function decodeJsonAudioPayload(payload: unknown): Buffer {
	if (!isRecord(payload)) {
		throw new TtsError("OUTPUT_INVALID", "XTTS JSON response must be an object.", {
			provider: "xtts",
			stage: "decode",
		});
	}

	const { audioBase64, format } = payload as Partial<XttsJsonResponse>;
	if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
		throw new TtsError("OUTPUT_INVALID", "XTTS JSON response is missing audioBase64 payload.", {
			provider: "xtts",
			stage: "decode",
		});
	}

	if (typeof format === "string" && format.trim() && format.trim().toLowerCase() !== "wav") {
		throw new TtsError(
			"OUTPUT_INVALID",
			`XTTS JSON response format must be "wav" when provided (received "${format}").`,
			{ provider: "xtts", stage: "decode" },
		);
	}

	const audioBuffer = Buffer.from(audioBase64.trim(), "base64");
	if (audioBuffer.length === 0) {
		throw new TtsError("OUTPUT_INVALID", "XTTS JSON response contains empty audioBase64 data.", {
			provider: "xtts",
			stage: "decode",
		});
	}

	return audioBuffer;
}

function mapXttsRequestError(err: unknown, context: XttsErrorContext): TtsError {
	if (context.timedOut || isAbortError(err)) {
		return new TtsError(
			"RUNTIME_UNAVAILABLE",
			`Timed out while contacting XTTS sidecar after ${context.timeoutMs}ms.`,
			{ provider: "xtts", stage: "request", cause: err },
		);
	}

	if (isConnectionFailure(err)) {
		return new TtsError("RUNTIME_UNAVAILABLE", `Unable to reach XTTS sidecar at ${context.endpoint}.`, {
			provider: "xtts",
			stage: "request",
			cause: err,
		});
	}

	return new TtsError("SYNTH_FAILED", "XTTS sidecar request failed.", {
		provider: "xtts",
		stage: "request",
		cause: err,
	});
}

async function readErrorMessage(response: Response): Promise<string> {
	let text = "";
	try {
		text = await response.text();
	} catch {
		return "";
	}

	const normalizedText = normalizeWhitespace(text);
	if (!normalizedText) return "";

	try {
		const payload = JSON.parse(text) as unknown;
		const fromPayload = extractErrorMessage(payload);
		if (fromPayload) return fromPayload;
	} catch {
		// Fall through to plain text.
	}

	return normalizedText;
}

function extractErrorMessage(payload: unknown): string {
	if (!isRecord(payload)) return "";
	if (typeof payload.error === "string") return normalizeWhitespace(payload.error);
	if (isRecord(payload.error) && typeof payload.error.message === "string") {
		return normalizeWhitespace(payload.error.message);
	}
	if (typeof payload.message === "string") return normalizeWhitespace(payload.message);
	return "";
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

async function playTempWav(wavBytes: Buffer): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), "herzen-xtts-"));
	const tempFile = join(tempDir, "speech.wav");

	try {
		await writeFile(tempFile, wavBytes);
		await playWavFile(tempFile, "xtts");
	} catch (err) {
		if (err instanceof TtsError) throw err;
		throw new TtsError("PLAYBACK_FAILED", "Failed to play XTTS output audio.", {
			provider: "xtts",
			stage: "playback",
			cause: err,
		});
	} finally {
		await cleanupTempWav(tempFile, tempDir);
	}
}

async function playWavFile(file: string, provider: TtsProvider): Promise<void> {
	try {
		await run("play", ["-q", "-v", PLAY_HEADROOM_GAIN, file, "pad", PLAY_LEAD_IN_SECONDS, "0"]);
		return;
	} catch (err) {
		if (!isCommandNotFound(err)) {
			throw new TtsError("PLAYBACK_FAILED", `SoX play failed for audio file: ${file}`, {
				provider,
				stage: "playback",
				cause: err,
			});
		}
	}

	try {
		await run("afplay", [file]);
	} catch (err) {
		throw new TtsError("PLAYBACK_FAILED", `afplay fallback failed for audio file: ${file}`, {
			provider,
			stage: "playback",
			cause: err,
		});
	}
}

async function cleanupTempWav(file: string, dir: string): Promise<void> {
	try {
		await unlink(file);
	} catch {
		// Ignore cleanup failure.
	}

	try {
		await rm(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup failure.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAbortError(err: unknown): boolean {
	return isRecord(err) && err.name === "AbortError";
}

function isConnectionFailure(err: unknown): boolean {
	const code = extractErrorCode(err);
	if (code && CONNECTION_ERROR_CODES.has(code)) return true;
	if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
	return false;
}

function isCommandNotFound(err: unknown): boolean {
	return extractErrorCode(err) === "ENOENT";
}

function extractErrorCode(err: unknown): string | undefined {
	let cursor: unknown = err;
	for (let depth = 0; depth < 5; depth += 1) {
		if (!isRecord(cursor)) return undefined;
		if (typeof cursor.code === "string" && cursor.code) return cursor.code;
		if (!("cause" in cursor)) return undefined;
		cursor = cursor.cause;
	}
	return undefined;
}

function logFallbackWarning(
	provider: TtsProvider,
	fallbackProvider: TtsProvider,
	language: TtsLanguage,
	err: unknown,
): void {
	const details =
		err instanceof TtsError ?
			{
				errorCode: err.code,
				stage: err.stage,
				message: err.message,
			} :
			err instanceof Error ?
			{
				message: err.message,
			} :
			{
				message: String(err),
			};

	console.warn("[@herzen/tts] Provider synth failed; attempting fallback provider.", {
		provider,
		fallbackProvider,
		language,
		...details,
	});
}

function assertNever(value: never): never {
	throw new TtsError("CONFIG_INVALID", `Unsupported TTS provider value: ${String(value)}`, {
		stage: "config",
	});
}

export async function speak(text: string): Promise<void> {
	const { lang, clean } = parseTaggedLanguage(text);
	const language: TtsLanguage = lang ?? (hasCyrillic(clean) ? "ru" : "en");
	const provider = resolveTtsProvider(process.env.HERZEN_TTS_PROVIDER);
	const fallbackProvider = resolveFallbackProvider(process.env.HERZEN_TTS_FALLBACK_PROVIDER);
	const request: SpeakRequest = {
		text: clean,
		language,
	};

	try {
		await speakWithProvider(provider, request, process.env);
	} catch (err) {
		if (provider === "say" || fallbackProvider === provider) throw err;
		logFallbackWarning(provider, fallbackProvider, language, err);
		await speakWithProvider(fallbackProvider, request, process.env);
	}
}

export async function listVoices(): Promise<void> {
	await run("say", ["-v", "?"]);
}

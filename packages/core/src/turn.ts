import { join } from "node:path";
import type { RecordingMode } from "./recording/factory.js";

const DEFAULT_RECORD_SECONDS = 3;
const DEFAULT_RECORD_MIN_SECONDS = 1;
const DEFAULT_RECORD_MAX_SECONDS = 12;
const DEFAULT_RECORD_SILENCE_SECONDS = 0.7;
const DEFAULT_RECORD_NO_SPEECH_TIMEOUT_SECONDS = 4;
const DEFAULT_VAD_START_THRESHOLD = 0.55;
const DEFAULT_VAD_END_THRESHOLD = 0.35;
const DEFAULT_VAD_FRAME_SAMPLES = 512;

const FALLBACK_SPEECH = "[en] I couldn't understand that.";
const RESPONSE_FALLBACK_SPEECH_EN = "[en] I heard you, but I can't respond right now.";
const RESPONSE_FALLBACK_SPEECH_RU = "[ru] Я вас услышал, но сейчас не могу ответить.";
const FALLBACK_RESPONSE_ERROR_CODE = "RESPONSE_UNAVAILABLE";

type RequestedResponseLanguage = "auto" | "en" | "ru";

export interface SttLogEntry {
	timestamp: string;
	audioFile: string;
	durationMs: number;
	latencyMs: number;
	languageMode: string;
	language?: string;
	transcript?: string;
	errorCode?: string;
	llmProvider?: string;
	llmModel?: string;
	llmLatencyMs?: number;
	llmOutcome?: "ok" | "error";
	llmErrorCode?: string;
}

export interface SttResultLike {
	text: string;
	language: string;
	durationMs: number;
}

export interface SttErrorLike {
	code: string;
	message: string;
}

export interface ResponseInputLike {
	transcript: string;
	detectedLanguage?: string;
	requestedLanguage?: RequestedResponseLanguage;
	timestampIso: string;
}

export interface ResponseOutputLike {
	text: string;
	language: "en" | "ru";
	provider: string;
	model: string;
	durationMs: number;
}

export interface ResponseErrorLike {
	code: string;
	message: string;
}

export interface TurnLogger {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export interface TriggerTurnDependencies {
	outDir: string;
	getEnv: () => NodeJS.ProcessEnv;
	now: () => number;
	nowIso: () => string;
	logger: TurnLogger;
	recordingMode: RecordingMode;
	recordAudioFixed: (file: string, seconds: number) => Promise<void>;
	recordAudioAdaptive: (
		file: string,
		config: AdaptiveRecordSettings,
	) => Promise<AdaptiveRecordResultLike>;
	transcribeWav: (file: string) => Promise<SttResultLike>;
	isSttError: (err: unknown) => err is SttErrorLike;
	generateResponse?: (input: ResponseInputLike) => Promise<ResponseOutputLike>;
	isResponseError?: (err: unknown) => err is ResponseErrorLike;
	appendSttLog: (entry: SttLogEntry) => Promise<void>;
	playAudio: (file: string) => Promise<void>;
	speak: (text: string) => Promise<void>;
}

export interface AdaptiveRecordSettings {
	minSeconds: number;
	maxSeconds: number;
	silenceSeconds: number;
	noSpeechTimeoutSeconds: number;
	startThreshold: number;
	endThreshold: number;
	frameSamples: number;
}

export interface AdaptiveRecordResultLike {
	durationSeconds: number;
	stopReason: string;
}

export function createSttTriggerHandler(deps: TriggerTurnDependencies): () => Promise<void> {
	return async () => {
		const env = deps.getEnv();
		const file = join(deps.outDir, `test-${deps.now()}.wav`);
		const languageMode = resolveSttLanguageMode(env.HERZEN_STT_LANGUAGE);
		const requestedLanguage = resolveRequestedResponseLanguage(languageMode);
		const recordSeconds = resolveRecordSeconds(env.HERZEN_RECORD_SECONDS, deps.logger);
		const playbackEnabled = resolvePlaybackEnabled(env.HERZEN_PLAYBACK);

		await recordTurnAudio(deps, file, env, recordSeconds);

		let latencyMs: number;
		let durationMs: number;
		let transcript = "";
		let language = "auto";
		let errorCode: string | undefined;
		let llmProvider: string | undefined;
		let llmModel: string | undefined;
		let llmLatencyMs: number | undefined;
		let llmOutcome: "ok" | "error" | undefined;
		let llmErrorCode: string | undefined;
		let speechText = FALLBACK_SPEECH;
		const sttStart = deps.now();

		try {
			const sttResult = await deps.transcribeWav(file);
			latencyMs = sttResult.durationMs;
			durationMs = sttResult.durationMs;
			transcript = sttResult.text.trim();
			language = sttResult.language;
			if (transcript) {
				const detected = detectedLanguageLabel(transcript, language);
				deps.logger.log(`[${detected} detected]`);
			} else {
				deps.logger.log("[no speech detected]");
			}
		} catch (err) {
			latencyMs = deps.now() - sttStart;
			durationMs = latencyMs;
			if (deps.isSttError(err)) {
				errorCode = err.code;
				deps.logger.error(`STT error (${err.code}): ${err.message}`);
			} else {
				errorCode = "UNKNOWN";
				deps.logger.error("STT error:", err);
			}
		}

		if (transcript) {
			if (deps.generateResponse) {
				const responseStartedAt = deps.now();
				try {
					const response = await deps.generateResponse({
						transcript,
						detectedLanguage: language,
						requestedLanguage,
						timestampIso: deps.nowIso(),
					});
					const responseText = response.text.trim();
					if (!responseText) {
						throw createOutputInvalidResponseError();
					}

					speechText = responseText;
					llmProvider = response.provider;
					llmModel = response.model;
					llmLatencyMs = response.durationMs;
					llmOutcome = "ok";
				} catch (err) {
					llmLatencyMs = deps.now() - responseStartedAt;
					llmOutcome = "error";
					llmErrorCode = resolveResponseErrorCode(err, deps.isResponseError);
					speechText = responseUnavailableSpeech(transcript, language);
					if (isResponseError(err, deps.isResponseError)) {
						deps.logger.error(`LLM response error (${err.code}): ${err.message}`);
					} else {
						deps.logger.error("LLM response error:", err);
					}
				}
			} else {
				llmOutcome = "error";
				llmErrorCode = FALLBACK_RESPONSE_ERROR_CODE;
				speechText = responseUnavailableSpeech(transcript, language);
				deps.logger.error("LLM response service unavailable.");
			}
		}

		try {
			await deps.appendSttLog({
				timestamp: deps.nowIso(),
				audioFile: file,
				durationMs,
				latencyMs,
				languageMode,
				language,
				transcript: transcript || undefined,
				errorCode,
				llmProvider,
				llmModel,
				llmLatencyMs,
				llmOutcome,
				llmErrorCode,
			});
		} catch (err) {
			deps.logger.error("Failed to write STT log:", err);
		}

		if (playbackEnabled) {
			deps.logger.log("Playing back…");
			await deps.playAudio(file);
		} else {
			deps.logger.log("Playback skipped. Set HERZEN_PLAYBACK=1 to enable.");
		}

		await deps.speak(speechText);

		deps.logger.log("Done:", file);
	};
}

function resolveRequestedResponseLanguage(languageMode: string): RequestedResponseLanguage {
	const normalized = languageMode.trim().toLowerCase();
	if (normalized === "en" || normalized === "ru") return normalized;
	return "auto";
}

function createOutputInvalidResponseError(): ResponseErrorLike {
	return {
		code: "OUTPUT_INVALID",
		message: "LLM returned an empty response.",
	};
}

function resolveResponseErrorCode(
	err: unknown,
	isResponseErrorGuard: TriggerTurnDependencies["isResponseError"],
): string {
	if (isResponseError(err, isResponseErrorGuard)) return err.code;
	return "UNKNOWN";
}

function isResponseError(
	err: unknown,
	isResponseErrorGuard: TriggerTurnDependencies["isResponseError"],
): err is ResponseErrorLike {
	if (isResponseErrorGuard?.(err)) return true;
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof (err as { code: unknown }).code === "string" &&
		"message" in err &&
		typeof (err as { message: unknown }).message === "string"
	);
}

function resolveSttLanguageMode(rawLanguage: string | undefined): string {
	const fromEnv = rawLanguage?.trim();
	return fromEnv || "auto";
}

function resolveRecordSeconds(rawSeconds: string | undefined, logger: TurnLogger): number {
	const trimmed = rawSeconds?.trim();
	if (!trimmed) return DEFAULT_RECORD_SECONDS;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		logger.error(
			`Invalid HERZEN_RECORD_SECONDS "${rawSeconds}". Falling back to ${DEFAULT_RECORD_SECONDS} seconds.`,
		);
		return DEFAULT_RECORD_SECONDS;
	}
	return Math.min(parsed, 30);
}

function resolvePlaybackEnabled(rawPlayback: string | undefined): boolean {
	const normalized = rawPlayback?.trim().toLowerCase();
	if (!normalized) return false;
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function recordTurnAudio(
	deps: TriggerTurnDependencies,
	file: string,
	env: NodeJS.ProcessEnv,
	fixedSeconds: number,
): Promise<void> {
	if (deps.recordingMode !== "adaptive") {
		deps.logger.log(`Triggered. Recording ${fixedSeconds.toFixed(1)} seconds…`);
		await deps.recordAudioFixed(file, fixedSeconds);
		return;
	}

	const adaptiveSettings = resolveAdaptiveRecordSettings(env, deps.logger);
	if (!adaptiveSettings) {
		deps.logger.log(`Triggered. Recording ${fixedSeconds.toFixed(1)} seconds…`);
		await deps.recordAudioFixed(file, fixedSeconds);
		return;
	}

	deps.logger.log("Triggered. Adaptive recording…");
	try {
		const adaptiveResult = await deps.recordAudioAdaptive(file, adaptiveSettings);
		deps.logger.log(
			`Adaptive stop: ${adaptiveResult.stopReason} (${adaptiveResult.durationSeconds.toFixed(2)}s).`,
		);
	} catch (err) {
		deps.logger.error("Adaptive recording failed. Falling back to fixed recording for this turn.");
		if (err instanceof Error) {
			deps.logger.error(`Adaptive recording error: ${err.message}`);
		} else {
			deps.logger.error("Adaptive recording error:", err);
		}
		deps.logger.log(`Recording fallback ${fixedSeconds.toFixed(1)} seconds…`);
		await deps.recordAudioFixed(file, fixedSeconds);
	}
}

function resolveAdaptiveRecordSettings(env: NodeJS.ProcessEnv, logger: TurnLogger): AdaptiveRecordSettings | null {
	try {
		const maxSeconds = resolvePositiveFiniteNumber(
			env.HERZEN_RECORD_MAX_SECONDS,
			DEFAULT_RECORD_MAX_SECONDS,
			"HERZEN_RECORD_MAX_SECONDS",
		);
		const minSeconds = resolvePositiveFiniteNumber(
			env.HERZEN_RECORD_MIN_SECONDS,
			DEFAULT_RECORD_MIN_SECONDS,
			"HERZEN_RECORD_MIN_SECONDS",
		);
		const silenceSeconds = resolvePositiveFiniteNumber(
			env.HERZEN_RECORD_SILENCE_SECONDS,
			DEFAULT_RECORD_SILENCE_SECONDS,
			"HERZEN_RECORD_SILENCE_SECONDS",
		);
		const noSpeechTimeoutSeconds = resolvePositiveFiniteNumber(
			env.HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS,
			DEFAULT_RECORD_NO_SPEECH_TIMEOUT_SECONDS,
			"HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS",
		);
		const startThreshold = resolveProbability(
			env.HERZEN_VAD_START_THRESHOLD,
			DEFAULT_VAD_START_THRESHOLD,
			"HERZEN_VAD_START_THRESHOLD",
		);
		const endThreshold = resolveProbability(
			env.HERZEN_VAD_END_THRESHOLD,
			DEFAULT_VAD_END_THRESHOLD,
			"HERZEN_VAD_END_THRESHOLD",
		);
		const frameSamples = resolvePositiveInteger(
			env.HERZEN_VAD_FRAME_SAMPLES,
			DEFAULT_VAD_FRAME_SAMPLES,
			"HERZEN_VAD_FRAME_SAMPLES",
		);

		if (minSeconds > maxSeconds) {
			throw new Error("HERZEN_RECORD_MIN_SECONDS must be <= HERZEN_RECORD_MAX_SECONDS.");
		}
		if (endThreshold > startThreshold) {
			throw new Error("HERZEN_VAD_END_THRESHOLD must be <= HERZEN_VAD_START_THRESHOLD.");
		}

		return {
			maxSeconds,
			minSeconds,
			silenceSeconds,
			noSpeechTimeoutSeconds,
			startThreshold,
			endThreshold,
			frameSamples,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(
			`Invalid adaptive recording config (${message}). Falling back to fixed recording for this turn.`,
		);
		return null;
	}
}

function resolvePositiveFiniteNumber(
	rawValue: string | undefined,
	fallback: number,
	envName: string,
): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${envName} must be a positive finite number (received "${rawValue}").`);
	}
	return parsed;
}

function resolveProbability(rawValue: string | undefined, fallback: number, envName: string): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(`${envName} must be in [0, 1] (received "${rawValue}").`);
	}
	return parsed;
}

function resolvePositiveInteger(rawValue: string | undefined, fallback: number, envName: string): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${envName} must be a positive integer (received "${rawValue}").`);
	}
	return parsed;
}

function hasCyrillic(text: string): boolean {
	return /[А-Яа-яЁё]/.test(text);
}

function responseUnavailableSpeech(transcript: string, language: string): string {
	if (detectedLanguageLabel(transcript, language) === "ru") return RESPONSE_FALLBACK_SPEECH_RU;
	return RESPONSE_FALLBACK_SPEECH_EN;
}

function detectedLanguageLabel(transcript: string, language: string): "en" | "ru" {
	if (language.toLowerCase().startsWith("ru") || hasCyrillic(transcript)) return "ru";
	return "en";
}

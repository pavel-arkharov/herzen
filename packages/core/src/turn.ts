import { join } from "node:path";

const DEFAULT_RECORD_SECONDS = 3;
const FALLBACK_SPEECH = "[en] I couldn't understand that.";

export interface SttLogEntry {
	timestamp: string;
	audioFile: string;
	durationMs: number;
	latencyMs: number;
	languageMode: string;
	language?: string;
	transcript?: string;
	errorCode?: string;
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
	recordAudio: (file: string, seconds: number) => Promise<void>;
	transcribeWav: (file: string) => Promise<SttResultLike>;
	isSttError: (err: unknown) => err is SttErrorLike;
	appendSttLog: (entry: SttLogEntry) => Promise<void>;
	playAudio: (file: string) => Promise<void>;
	speak: (text: string) => Promise<void>;
}

export function createSttTriggerHandler(deps: TriggerTurnDependencies): () => Promise<void> {
	return async () => {
		const env = deps.getEnv();
		const file = join(deps.outDir, `test-${deps.now()}.wav`);
		const languageMode = resolveSttLanguageMode(env.HERZEN_STT_LANGUAGE);
		const recordSeconds = resolveRecordSeconds(env.HERZEN_RECORD_SECONDS, deps.logger);
		const playbackEnabled = resolvePlaybackEnabled(env.HERZEN_PLAYBACK);

		deps.logger.log(`Triggered. Recording ${recordSeconds.toFixed(1)} seconds…`);
		await deps.recordAudio(file, recordSeconds);

		let latencyMs: number;
		let durationMs: number;
		let transcript = "";
		let language = "auto";
		let errorCode: string | undefined;
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

		if (transcript) {
			await deps.speak(confirmationSpeech(transcript, language));
		} else {
			await deps.speak(FALLBACK_SPEECH);
		}

		deps.logger.log("Done:", file);
	};
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

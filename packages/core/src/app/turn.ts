import { join } from "node:path";
import type { ConversationContextItem } from "@herzen/dialog";
import type { RecordingMode } from "../recording/factory.js";

const DEFAULT_RECORD_SECONDS = 3;
const DEFAULT_RECORD_MIN_SECONDS = 1;
const DEFAULT_RECORD_MAX_SECONDS = 60;
const DEFAULT_RECORD_SILENCE_SECONDS = 0.7;
const DEFAULT_RECORD_NO_SPEECH_TIMEOUT_SECONDS = 4;
const DEFAULT_VAD_START_THRESHOLD = 0.55;
const DEFAULT_VAD_END_THRESHOLD = 0.35;
const DEFAULT_VAD_FRAME_SAMPLES = 512;

const FALLBACK_SPEECH = "[en] I couldn't understand that.";
const RESPONSE_FALLBACK_SPEECH_EN = "[en] I heard you, but I can't respond right now.";
const RESPONSE_FALLBACK_SPEECH_RU = "[ru] Я вас услышал, но сейчас не могу ответить.";
const FALLBACK_RESPONSE_ERROR_CODE = "RESPONSE_UNAVAILABLE";
const MIN_RECORD_SECONDS = 0.2;

type RequestedResponseLanguage = "auto" | "en" | "ru";
type TurnBenchmarkLanguage = "en" | "ru" | "mixed" | "unknown";
type TurnBenchmarkActionPath = "home_assistant" | "llm" | "none";
export type TurnIngressSource = "voice" | "tui" | "automation";

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
	turn?: number;
	transcript: string;
	detectedLanguage?: string;
	requestedLanguage?: RequestedResponseLanguage;
	timestampIso: string;
	control?: {
		traceId: string;
		laneKey: string;
	};
	conversationContext?: ConversationContextItem[];
}

export interface ResponseOutputLike {
	text: string;
	language: "en" | "ru";
	provider: string;
	model: string;
	durationMs: number;
	actionPath?: Exclude<TurnBenchmarkActionPath, "none">;
	haIntentStartedAtMs?: number;
	haIntentFinishedAtMs?: number;
	llmStartedAtMs?: number;
	llmFirstTokenAtMs?: number;
	llmFinishedAtMs?: number;
}

export interface ResponseErrorLike {
	code: string;
	message: string;
}

export interface UserUtteranceRecord {
	turn: number;
	text: string;
	ingressSource: TurnIngressSource;
	detectedLanguage?: string;
	requestedLanguage?: RequestedResponseLanguage;
}

export interface AssistantUtteranceRecord {
	turn: number;
	text: string;
	ingressSource: TurnIngressSource;
	language?: "en" | "ru";
	provider?: string;
	model?: string;
}

export interface TurnErrorRecord {
	turn: number;
	stage: "stt" | "response" | "telemetry";
	code?: string;
	message: string;
	details?: Record<string, unknown>;
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
	playInputStartCue?: () => Promise<void>;
	transcribeWav: (file: string) => Promise<SttResultLike>;
	isSttError: (err: unknown) => err is SttErrorLike;
	generateResponse?: (input: ResponseInputLike) => Promise<ResponseOutputLike>;
	isResponseError?: (err: unknown) => err is ResponseErrorLike;
	getConversationContext?: (input: {
		turn: number;
		transcript: string;
		detectedLanguage?: string;
	}) => ConversationContextItem[];
	onTurnOutcome?: (outcome: TurnOutcome) => Promise<void> | void;
	appendSttLog: (entry: SttLogEntry) => Promise<void>;
	onUserUtterance?: (event: UserUtteranceRecord) => Promise<void> | void;
	onAssistantUtterance?: (event: AssistantUtteranceRecord) => Promise<void> | void;
	onError?: (event: TurnErrorRecord) => Promise<void> | void;
	playAudio: (file: string) => Promise<void>;
	speak: (text: string) => Promise<void>;
	appendPerfEvent?: (event: {
		phase: "turn" | "record" | "stt" | "llm" | "tts" | "playback";
		status: "started" | "ok" | "error" | "skipped";
		turn: number;
		mode: TurnInvocationMode;
		durationMs?: number;
		fields?: Record<string, unknown>;
	}) => Promise<void> | void;
	appendTurnBenchmark?: (entry: TurnBenchmarkLogEntry) => Promise<void> | void;
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

interface RecordTurnAudioResult {
	strategy: "fixed" | "adaptive";
	requestedSeconds: number;
	fallbackUsed: boolean;
	capturedSeconds?: number;
	adaptiveStopReason?: string;
	adaptiveError?: string;
}

interface TurnBenchmarkTimeline {
	triggerReceivedAtMs: number;
	recordingStartedAtMs?: number;
	recordingFinishedAtMs?: number;
	sttStartedAtMs?: number;
	sttFinishedAtMs?: number;
	haIntentStartedAtMs?: number;
	haIntentFinishedAtMs?: number;
	llmStartedAtMs?: number;
	llmFirstTokenAtMs?: number;
	llmFinishedAtMs?: number;
	ttsStartedAtMs?: number;
	ttsFirstAudioSampleAtMs?: number;
	ttsFinishedAtMs?: number;
}

export type TurnInvocationMode = "trigger" | "followup";

export interface RunSttTurnOptions {
	mode?: TurnInvocationMode;
	remainingWindowMs?: number;
	suppressNoSpeechFallback?: boolean;
	triggerReceivedAtMs?: number;
	triggerMode?: "wakeword" | "stdin";
	ingressSource?: TurnIngressSource;
	traceId?: string;
	laneKey?: string;
}

export interface RunTextTurnOptions {
	mode?: TurnInvocationMode;
	triggerReceivedAtMs?: number;
	triggerMode?: "wakeword" | "stdin";
	ingressSource?: TurnIngressSource;
	traceId?: string;
	laneKey?: string;
}

export interface TurnBenchmarkLogEntry {
	schemaVersion: "turn_benchmark.v1";
	ts: string;
	turn: number;
	triggerMode: "wakeword" | "stdin" | "unknown";
	invocationMode: TurnInvocationMode;
	actionPath: TurnBenchmarkActionPath;
	language: TurnBenchmarkLanguage;
	trigger_received?: string;
	recording_started?: string;
	recording_finished?: string;
	stt_started?: string;
	stt_finished?: string;
	ha_intent_started?: string;
	ha_intent_finished?: string;
	llm_started?: string;
	llm_first_token?: string;
	llm_finished?: string;
	tts_started?: string;
	tts_first_audio_sample?: string;
	tts_finished?: string;
	stt_ms?: number;
	ha_intent_ms?: number;
	llm_ms?: number;
	tts_ms?: number;
	end_to_end_ms?: number;
	speak_tail_ms?: number;
	hasTranscript: boolean;
	transcriptChars: number;
	llmOutcome?: "ok" | "error";
	errorCode?: string;
}

export interface TurnOutcome {
	turn: number;
	hasTranscript: boolean;
	transcript?: string;
	detectedLanguage?: string;
	assistantText: string;
	assistantLanguage?: "en" | "ru";
	assistantSource: "model" | "fallback";
	llmOutcome?: "ok" | "error";
}

export function createSttTriggerHandler(deps: TriggerTurnDependencies): () => Promise<void> {
	let turn = 0;

	return async () => {
		const outcome = await runSttTurn(deps, ++turn, { mode: "trigger" });
		await executeJournalHook(deps.logger, "Failed to process turn outcome hook", () =>
			deps.onTurnOutcome?.(outcome),
		);
	};
}

export async function runTextTurn(
	deps: TriggerTurnDependencies,
	turnNumber: number,
	inputText: string,
	options: RunTextTurnOptions = {},
): Promise<TurnOutcome> {
	const mode = options.mode ?? "trigger";
	const triggerMode = options.triggerMode ?? "unknown";
	const ingressSource = options.ingressSource ?? "tui";
	const env = deps.getEnv();
	const transcript = inputText.trim();
	const languageMode = resolveSttLanguageMode(env.HERZEN_STT_LANGUAGE);
	const requestedLanguage = resolveRequestedResponseLanguage(languageMode);
	const language = detectedLanguageLabel(transcript, languageMode);
	const timeline: TurnBenchmarkTimeline = {
		triggerReceivedAtMs: options.triggerReceivedAtMs ?? Date.now(),
	};
	const turnStartedAt = Date.now();
	let actionPath: TurnBenchmarkActionPath = "none";
	let llmProvider: string | undefined;
	let llmModel: string | undefined;
	let llmLatencyMs: number | undefined;
	let llmOutcome: "ok" | "error" | undefined;
	let llmErrorCode: string | undefined;
	let speechText = "";
	let speechLanguage: "en" | "ru" = language;
	let assistantSource: "model" | "fallback";

	void appendPerfEvent(deps, {
		phase: "turn",
		status: "started",
		turn: turnNumber,
		mode,
		fields: {
			textIngress: true,
			transcriptChars: transcript.length,
		},
	});

	if (!transcript) {
		void appendPerfEvent(deps, {
			phase: "llm",
			status: "skipped",
			turn: turnNumber,
			mode,
			fields: {
				reason: "empty_text",
			},
		});
		void appendPerfEvent(deps, {
			phase: "tts",
			status: "skipped",
			turn: turnNumber,
			mode,
			fields: {
				reason: "empty_text",
			},
		});
		void appendPerfEvent(deps, {
			phase: "playback",
			status: "skipped",
			turn: turnNumber,
			mode,
			fields: {
				reason: "text_ingress",
			},
		});
		const outcome: TurnOutcome = {
			turn: turnNumber,
			hasTranscript: false,
			assistantText: "",
			assistantLanguage: language,
			assistantSource: "fallback",
			llmOutcome: undefined,
		};
		void appendPerfEvent(deps, {
			phase: "turn",
			status: "ok",
			turn: turnNumber,
			mode,
			durationMs: Date.now() - turnStartedAt,
			fields: {
				hasTranscript: false,
				assistantSource: outcome.assistantSource,
			},
		});
		await appendTurnBenchmark(deps, {
			schemaVersion: "turn_benchmark.v1",
			ts: deps.nowIso(),
			turn: turnNumber,
			triggerMode,
			invocationMode: mode,
			actionPath,
			language: "unknown",
			trigger_received: toIsoTimestamp(timeline.triggerReceivedAtMs),
			llm_started: toIsoTimestamp(timeline.llmStartedAtMs),
			llm_first_token: toIsoTimestamp(timeline.llmFirstTokenAtMs),
			llm_finished: toIsoTimestamp(timeline.llmFinishedAtMs),
			tts_started: toIsoTimestamp(timeline.ttsStartedAtMs),
			tts_first_audio_sample: toIsoTimestamp(timeline.ttsFirstAudioSampleAtMs),
			tts_finished: toIsoTimestamp(timeline.ttsFinishedAtMs),
			llm_ms: durationBetween(timeline.llmStartedAtMs, timeline.llmFinishedAtMs),
			tts_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
			end_to_end_ms: durationBetween(timeline.triggerReceivedAtMs, timeline.ttsStartedAtMs),
			speak_tail_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
			hasTranscript: false,
			transcriptChars: 0,
			errorCode: llmErrorCode,
		});
		return outcome;
	}

	scheduleJournalHook(deps.logger, "Failed to write user utterance journal event", () =>
		deps.onUserUtterance?.({
			turn: turnNumber,
			text: transcript,
			ingressSource,
			detectedLanguage: language,
			requestedLanguage,
		}),
	);

	if (deps.generateResponse) {
		const responseStartedAt = deps.now();
		const responseStartedAtMs = Date.now();
		void appendPerfEvent(deps, {
			phase: "llm",
			status: "started",
			turn: turnNumber,
			mode,
		});
		try {
			const responseInput: ResponseInputLike = {
				turn: turnNumber,
				transcript,
				detectedLanguage: language,
				requestedLanguage,
				timestampIso: deps.nowIso(),
			};
			if (options.traceId && options.laneKey) {
				responseInput.control = {
					traceId: options.traceId,
					laneKey: options.laneKey,
				};
			}
			const conversationContext = deps.getConversationContext?.({
				turn: turnNumber,
				transcript,
				detectedLanguage: language,
			});
			if (conversationContext && conversationContext.length > 0) {
				responseInput.conversationContext = conversationContext;
			}

			const response = await deps.generateResponse(responseInput);
			const responseText = response.text.trim();
			if (!responseText) {
				throw createOutputInvalidResponseError();
			}

			speechText = responseText;
			speechLanguage = response.language;
			llmProvider = response.provider;
			llmModel = response.model;
			llmLatencyMs = response.durationMs;
			actionPath = response.actionPath ?? inferActionPath(response.provider);
			timeline.haIntentStartedAtMs = response.haIntentStartedAtMs;
			timeline.haIntentFinishedAtMs = response.haIntentFinishedAtMs;
			timeline.llmFirstTokenAtMs = response.llmFirstTokenAtMs;
			if (actionPath === "llm") {
				timeline.llmStartedAtMs = response.llmStartedAtMs ?? responseStartedAtMs;
				timeline.llmFinishedAtMs = response.llmFinishedAtMs ?? Date.now();
			}
			llmOutcome = "ok";
			assistantSource = "model";
			void appendPerfEvent(deps, {
				phase: "llm",
				status: "ok",
				turn: turnNumber,
				mode,
				durationMs: response.durationMs,
				fields: {
					provider: response.provider,
					model: response.model,
					llmDurationMs: response.durationMs,
					transcriptChars: transcript.length,
					contextItems: conversationContext?.length ?? 0,
					textIngress: true,
				},
			});
		} catch (err) {
			llmLatencyMs = deps.now() - responseStartedAt;
			llmOutcome = "error";
			actionPath = "llm";
			timeline.llmStartedAtMs = responseStartedAtMs;
			timeline.llmFinishedAtMs = Date.now();
			llmErrorCode = resolveResponseErrorCode(err, deps.isResponseError);
			speechText = responseUnavailableSpeech(transcript, language);
			speechLanguage = responseUnavailableLanguage(transcript, language);
			assistantSource = "fallback";
			if (isResponseError(err, deps.isResponseError)) {
				deps.logger.error(`LLM response error (${err.code}): ${err.message}`);
			} else {
				deps.logger.error("LLM response error:", err);
			}
			await executeJournalHook(deps.logger, "Failed to write response error journal event", () =>
				deps.onError?.({
					turn: turnNumber,
					stage: "response",
					code: llmErrorCode,
					message: errorMessage(err, "Unknown response error."),
				}),
			);
			void appendPerfEvent(deps, {
				phase: "llm",
				status: "error",
				turn: turnNumber,
				mode,
				durationMs: llmLatencyMs,
				fields: {
					errorCode: llmErrorCode,
					message: errorMessage(err, "Unknown response error."),
					textIngress: true,
				},
			});
		}
	} else {
		llmOutcome = "error";
		actionPath = "llm";
		timeline.llmStartedAtMs = Date.now();
		timeline.llmFinishedAtMs = timeline.llmStartedAtMs;
		llmErrorCode = FALLBACK_RESPONSE_ERROR_CODE;
		speechText = responseUnavailableSpeech(transcript, language);
		speechLanguage = responseUnavailableLanguage(transcript, language);
		assistantSource = "fallback";
		deps.logger.error("LLM response service unavailable.");
		await executeJournalHook(deps.logger, "Failed to write response unavailable journal event", () =>
			deps.onError?.({
				turn: turnNumber,
				stage: "response",
				code: llmErrorCode,
				message: "LLM response service unavailable.",
			}),
		);
		void appendPerfEvent(deps, {
			phase: "llm",
			status: "error",
			turn: turnNumber,
			mode,
			fields: {
				errorCode: llmErrorCode,
				message: "LLM response service unavailable.",
			},
		});
	}

	try {
		await deps.appendSttLog({
			timestamp: deps.nowIso(),
			audioFile: "control.ingress",
			durationMs: 0,
			latencyMs: 0,
			languageMode,
			language,
			transcript,
			llmProvider,
			llmModel,
			llmLatencyMs,
			llmOutcome,
			llmErrorCode,
		});
	} catch (err) {
		deps.logger.error("Failed to write STT log:", err);
		await executeJournalHook(deps.logger, "Failed to write telemetry error journal event", () =>
			deps.onError?.({
				turn: turnNumber,
				stage: "telemetry",
				message: "Failed to write STT telemetry log.",
				details: {
					error: errorMessage(err, "Unknown telemetry write error."),
				},
			}),
		);
	}

	scheduleJournalHook(deps.logger, "Failed to write assistant utterance journal event", () =>
		deps.onAssistantUtterance?.({
			turn: turnNumber,
			text: speechText,
			ingressSource,
			language: speechLanguage,
			provider: llmProvider,
			model: llmModel,
		}),
	);
	const ttsStartedAt = Date.now();
	timeline.ttsStartedAtMs = ttsStartedAt;
	void appendPerfEvent(deps, {
		phase: "tts",
		status: "started",
		turn: turnNumber,
		mode,
		fields: {
			textChars: speechText.length,
			textIngress: true,
		},
	});
	try {
		await deps.speak(speechText);
		timeline.ttsFinishedAtMs = Date.now();
		timeline.ttsFirstAudioSampleAtMs = timeline.ttsFinishedAtMs;
		void appendPerfEvent(deps, {
			phase: "tts",
			status: "ok",
			turn: turnNumber,
			mode,
			durationMs: Date.now() - ttsStartedAt,
			fields: {
				textChars: speechText.length,
				textIngress: true,
			},
		});
	} catch (err) {
		deps.logger.error("TTS error:", err);
		timeline.ttsFinishedAtMs = Date.now();
		timeline.ttsFirstAudioSampleAtMs = timeline.ttsFinishedAtMs;
		void appendPerfEvent(deps, {
			phase: "tts",
			status: "error",
			turn: turnNumber,
			mode,
			durationMs: Date.now() - ttsStartedAt,
			fields: {
				message: errorMessage(err, "Unknown TTS error."),
				textIngress: true,
			},
		});
	}

	void appendPerfEvent(deps, {
		phase: "playback",
		status: "skipped",
		turn: turnNumber,
		mode,
		fields: {
			reason: "text_ingress",
		},
	});
	const outcome: TurnOutcome = {
		turn: turnNumber,
		hasTranscript: true,
		transcript,
		detectedLanguage: language,
		assistantText: speechText,
		assistantLanguage: speechLanguage,
		assistantSource,
		llmOutcome,
	};
	void appendPerfEvent(deps, {
		phase: "turn",
		status: "ok",
		turn: turnNumber,
		mode,
		durationMs: Date.now() - turnStartedAt,
		fields: {
			hasTranscript: outcome.hasTranscript,
			assistantSource: outcome.assistantSource,
			llmOutcome: outcome.llmOutcome,
			textIngress: true,
		},
	});

	await appendTurnBenchmark(deps, {
		schemaVersion: "turn_benchmark.v1",
		ts: deps.nowIso(),
		turn: turnNumber,
		triggerMode,
		invocationMode: mode,
		actionPath,
		language: classifyTurnLanguage(transcript, language),
		trigger_received: toIsoTimestamp(timeline.triggerReceivedAtMs),
		ha_intent_started: toIsoTimestamp(timeline.haIntentStartedAtMs),
		ha_intent_finished: toIsoTimestamp(timeline.haIntentFinishedAtMs),
		llm_started: toIsoTimestamp(timeline.llmStartedAtMs),
		llm_first_token: toIsoTimestamp(timeline.llmFirstTokenAtMs),
		llm_finished: toIsoTimestamp(timeline.llmFinishedAtMs),
		tts_started: toIsoTimestamp(timeline.ttsStartedAtMs),
		tts_first_audio_sample: toIsoTimestamp(timeline.ttsFirstAudioSampleAtMs),
		tts_finished: toIsoTimestamp(timeline.ttsFinishedAtMs),
		ha_intent_ms: durationBetween(timeline.haIntentStartedAtMs, timeline.haIntentFinishedAtMs),
		llm_ms: durationBetween(timeline.llmStartedAtMs, timeline.llmFinishedAtMs),
		tts_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
		end_to_end_ms: durationBetween(timeline.triggerReceivedAtMs, timeline.ttsStartedAtMs),
		speak_tail_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
		hasTranscript: outcome.hasTranscript,
		transcriptChars: transcript.length,
		llmOutcome: outcome.llmOutcome,
		errorCode: llmErrorCode,
	});

	return outcome;
}

export async function runSttTurn(
	deps: TriggerTurnDependencies,
	turnNumber: number,
	options: RunSttTurnOptions = {},
): Promise<TurnOutcome> {
	const mode = options.mode ?? "trigger";
	const triggerMode = options.triggerMode ?? "unknown";
	const ingressSource = options.ingressSource ?? "voice";
	const suppressNoSpeechFallback = mode === "followup" && options.suppressNoSpeechFallback === true;
	const remainingWindowSeconds = toRemainingWindowSeconds(options.remainingWindowMs);
	const env = deps.getEnv();
	const file = join(deps.outDir, `test-${deps.now()}.wav`);
	const languageMode = resolveSttLanguageMode(env.HERZEN_STT_LANGUAGE);
	const requestedLanguage = resolveRequestedResponseLanguage(languageMode);
	const recordSeconds = resolveRecordSeconds(env.HERZEN_RECORD_SECONDS, deps.logger);
	const effectiveRecordSeconds =
		mode === "followup" && remainingWindowSeconds !== undefined
			? Math.max(MIN_RECORD_SECONDS, remainingWindowSeconds)
			: recordSeconds;
	const playbackEnabled = resolvePlaybackEnabled(env.HERZEN_PLAYBACK);
	const timeline: TurnBenchmarkTimeline = {
		triggerReceivedAtMs: options.triggerReceivedAtMs ?? Date.now(),
	};
	let actionPath: TurnBenchmarkActionPath = "none";
	let benchmarkErrorCode: string | undefined;
	const turnStartedAt = Date.now();

	void appendPerfEvent(deps, {
		phase: "turn",
		status: "started",
		turn: turnNumber,
		mode,
		fields: {
			recordingMode: deps.recordingMode,
			remainingWindowMs: options.remainingWindowMs,
			playbackEnabled,
		},
	});

	if (mode === "trigger") {
		try {
			await deps.playInputStartCue?.();
		} catch (err) {
			deps.logger.error("Start cue error:", err);
		}
	}

	const recordStartedAt = Date.now();
	timeline.recordingStartedAtMs = recordStartedAt;
	void appendPerfEvent(deps, {
		phase: "record",
		status: "started",
		turn: turnNumber,
		mode,
		fields: {
			requestedSeconds: effectiveRecordSeconds,
			recordingMode: deps.recordingMode,
		},
	});

	let recordResult: RecordTurnAudioResult;
	try {
		recordResult = await recordTurnAudio(deps, file, env, effectiveRecordSeconds, {
			mode,
			remainingWindowSeconds,
		});
		timeline.recordingFinishedAtMs = Date.now();
		void appendPerfEvent(deps, {
			phase: "record",
			status: "ok",
			turn: turnNumber,
			mode,
			durationMs: Date.now() - recordStartedAt,
			fields: {
				strategy: recordResult.strategy,
				requestedSeconds: recordResult.requestedSeconds,
				fallbackUsed: recordResult.fallbackUsed,
				capturedSeconds: recordResult.capturedSeconds,
				adaptiveStopReason: recordResult.adaptiveStopReason,
				adaptiveError: recordResult.adaptiveError,
			},
		});
	} catch (err) {
		timeline.recordingFinishedAtMs = Date.now();
		benchmarkErrorCode = resolveGenericErrorCode(err, "RECORD_FAILED");
		void appendPerfEvent(deps, {
			phase: "record",
			status: "error",
			turn: turnNumber,
			mode,
			durationMs: Date.now() - recordStartedAt,
			fields: {
				message: errorMessage(err, "Unknown recording error."),
			},
		});
		void appendPerfEvent(deps, {
			phase: "turn",
			status: "error",
			turn: turnNumber,
			mode,
			durationMs: Date.now() - turnStartedAt,
			fields: {
				errorStage: "record",
				message: errorMessage(err, "Unknown recording error."),
			},
		});
		await appendTurnBenchmark(deps, {
			schemaVersion: "turn_benchmark.v1",
			ts: deps.nowIso(),
			turn: turnNumber,
			triggerMode,
			invocationMode: mode,
			actionPath,
			language: "unknown",
			trigger_received: toIsoTimestamp(timeline.triggerReceivedAtMs),
			recording_started: toIsoTimestamp(timeline.recordingStartedAtMs),
			recording_finished: toIsoTimestamp(timeline.recordingFinishedAtMs),
			stt_started: toIsoTimestamp(timeline.sttStartedAtMs),
			stt_finished: toIsoTimestamp(timeline.sttFinishedAtMs),
			ha_intent_started: toIsoTimestamp(timeline.haIntentStartedAtMs),
			ha_intent_finished: toIsoTimestamp(timeline.haIntentFinishedAtMs),
			llm_started: toIsoTimestamp(timeline.llmStartedAtMs),
			llm_first_token: toIsoTimestamp(timeline.llmFirstTokenAtMs),
			llm_finished: toIsoTimestamp(timeline.llmFinishedAtMs),
			tts_started: toIsoTimestamp(timeline.ttsStartedAtMs),
			tts_first_audio_sample: toIsoTimestamp(timeline.ttsFirstAudioSampleAtMs),
			tts_finished: toIsoTimestamp(timeline.ttsFinishedAtMs),
			stt_ms: durationBetween(timeline.sttStartedAtMs, timeline.sttFinishedAtMs),
			ha_intent_ms: durationBetween(timeline.haIntentStartedAtMs, timeline.haIntentFinishedAtMs),
			llm_ms: durationBetween(timeline.llmStartedAtMs, timeline.llmFinishedAtMs),
			tts_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
			end_to_end_ms: durationBetween(timeline.triggerReceivedAtMs, timeline.ttsStartedAtMs),
			speak_tail_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
			hasTranscript: false,
			transcriptChars: 0,
			errorCode: benchmarkErrorCode,
		});
		throw err;
	}

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
	let speechLanguage: "en" | "ru" = "en";
	let assistantSource: "model" | "fallback" = "fallback";
	let shouldSpeak = true;
	const sttStart = deps.now();
	timeline.sttStartedAtMs = Date.now();
	void appendPerfEvent(deps, {
		phase: "stt",
		status: "started",
		turn: turnNumber,
		mode,
	});

	try {
		const sttResult = await deps.transcribeWav(file);
		latencyMs = sttResult.durationMs;
		durationMs = sttResult.durationMs;
		transcript = sttResult.text.trim();
		language = sttResult.language;
		timeline.sttFinishedAtMs = Date.now();

		void appendPerfEvent(deps, {
			phase: "stt",
			status: "ok",
			turn: turnNumber,
			mode,
			durationMs: latencyMs,
			fields: {
				sttDurationMs: sttResult.durationMs,
				language,
				transcriptChars: transcript.length,
			},
		});

		if (transcript) {
			const detected = detectedLanguageLabel(transcript, language);
			deps.logger.log(`[${detected} detected]`);
			scheduleJournalHook(deps.logger, "Failed to write user utterance journal event", () =>
				deps.onUserUtterance?.({
					turn: turnNumber,
					text: transcript,
					ingressSource,
					detectedLanguage: language,
					requestedLanguage,
				}),
			);
		} else {
			deps.logger.log("[no speech detected]");
			if (suppressNoSpeechFallback) {
				shouldSpeak = false;
			}
		}
	} catch (err) {
		latencyMs = deps.now() - sttStart;
		durationMs = latencyMs;
		timeline.sttFinishedAtMs = Date.now();
		if (deps.isSttError(err)) {
			errorCode = err.code;
			deps.logger.error(`STT error (${err.code}): ${err.message}`);
		} else {
			errorCode = "UNKNOWN";
			deps.logger.error("STT error:", err);
		}
		await executeJournalHook(deps.logger, "Failed to write STT error journal event", () =>
			deps.onError?.({
				turn: turnNumber,
				stage: "stt",
				code: errorCode,
				message: errorMessage(err, "Unknown STT error."),
			}),
		);
		void appendPerfEvent(deps, {
			phase: "stt",
			status: "error",
			turn: turnNumber,
			mode,
			durationMs: latencyMs,
			fields: {
				errorCode,
				message: errorMessage(err, "Unknown STT error."),
			},
		});
	}

	if (transcript) {
		if (deps.generateResponse) {
			const responseStartedAt = deps.now();
			const responseStartedAtMs = Date.now();
			void appendPerfEvent(deps, {
				phase: "llm",
				status: "started",
				turn: turnNumber,
				mode,
			});
			try {
				const responseInput: ResponseInputLike = {
					turn: turnNumber,
					transcript,
					detectedLanguage: language,
					requestedLanguage,
					timestampIso: deps.nowIso(),
				};
				if (options.traceId && options.laneKey) {
					responseInput.control = {
						traceId: options.traceId,
						laneKey: options.laneKey,
					};
				}
				const conversationContext = deps.getConversationContext?.({
					turn: turnNumber,
					transcript,
					detectedLanguage: language,
				});
				if (conversationContext && conversationContext.length > 0) {
					responseInput.conversationContext = conversationContext;
				}

				const response = await deps.generateResponse(responseInput);
				const responseText = response.text.trim();
				if (!responseText) {
					throw createOutputInvalidResponseError();
				}

				speechText = responseText;
				speechLanguage = response.language;
				llmProvider = response.provider;
				llmModel = response.model;
				llmLatencyMs = response.durationMs;
				actionPath = response.actionPath ?? inferActionPath(response.provider);
				timeline.haIntentStartedAtMs = response.haIntentStartedAtMs;
				timeline.haIntentFinishedAtMs = response.haIntentFinishedAtMs;
				timeline.llmFirstTokenAtMs = response.llmFirstTokenAtMs;
				if (actionPath === "llm") {
					timeline.llmStartedAtMs = response.llmStartedAtMs ?? responseStartedAtMs;
					timeline.llmFinishedAtMs = response.llmFinishedAtMs ?? Date.now();
				}
				llmOutcome = "ok";
				assistantSource = "model";
				void appendPerfEvent(deps, {
					phase: "llm",
					status: "ok",
					turn: turnNumber,
					mode,
					durationMs: response.durationMs,
					fields: {
						provider: response.provider,
						model: response.model,
						llmDurationMs: response.durationMs,
						transcriptChars: transcript.length,
						contextItems: conversationContext?.length ?? 0,
					},
				});
			} catch (err) {
				llmLatencyMs = deps.now() - responseStartedAt;
				llmOutcome = "error";
				actionPath = "llm";
				timeline.llmStartedAtMs = responseStartedAtMs;
				timeline.llmFinishedAtMs = Date.now();
				llmErrorCode = resolveResponseErrorCode(err, deps.isResponseError);
				speechText = responseUnavailableSpeech(transcript, language);
				speechLanguage = responseUnavailableLanguage(transcript, language);
				assistantSource = "fallback";
				if (isResponseError(err, deps.isResponseError)) {
					deps.logger.error(`LLM response error (${err.code}): ${err.message}`);
				} else {
					deps.logger.error("LLM response error:", err);
				}
				await executeJournalHook(deps.logger, "Failed to write response error journal event", () =>
					deps.onError?.({
						turn: turnNumber,
						stage: "response",
						code: llmErrorCode,
						message: errorMessage(err, "Unknown response error."),
					}),
				);
				void appendPerfEvent(deps, {
					phase: "llm",
					status: "error",
					turn: turnNumber,
					mode,
					durationMs: llmLatencyMs,
					fields: {
						errorCode: llmErrorCode,
						message: errorMessage(err, "Unknown response error."),
					},
				});
			}
		} else {
			llmOutcome = "error";
			actionPath = "llm";
			timeline.llmStartedAtMs = Date.now();
			timeline.llmFinishedAtMs = timeline.llmStartedAtMs;
			llmErrorCode = FALLBACK_RESPONSE_ERROR_CODE;
			speechText = responseUnavailableSpeech(transcript, language);
			speechLanguage = responseUnavailableLanguage(transcript, language);
			assistantSource = "fallback";
			deps.logger.error("LLM response service unavailable.");
			await executeJournalHook(deps.logger, "Failed to write response unavailable journal event", () =>
				deps.onError?.({
					turn: turnNumber,
					stage: "response",
					code: llmErrorCode,
					message: "LLM response service unavailable.",
				}),
			);
			void appendPerfEvent(deps, {
				phase: "llm",
				status: "error",
				turn: turnNumber,
				mode,
				fields: {
					errorCode: llmErrorCode,
					message: "LLM response service unavailable.",
				},
			});
		}
	} else {
		actionPath = "none";
		void appendPerfEvent(deps, {
			phase: "llm",
			status: "skipped",
			turn: turnNumber,
			mode,
			fields: {
				reason: "no_transcript",
			},
		});
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
		await executeJournalHook(deps.logger, "Failed to write telemetry error journal event", () =>
			deps.onError?.({
				turn: turnNumber,
				stage: "telemetry",
				message: "Failed to write STT telemetry log.",
				details: {
					error: errorMessage(err, "Unknown telemetry write error."),
				},
			}),
		);
	}

	const outcome: TurnOutcome = {
		turn: turnNumber,
		hasTranscript: transcript.length > 0,
		transcript: transcript || undefined,
		detectedLanguage: transcript ? language : undefined,
		assistantText: shouldSpeak ? speechText : "",
		assistantLanguage: speechLanguage,
		assistantSource,
		llmOutcome,
	};

	if (playbackEnabled) {
		deps.logger.log("Playing back…");
		const playbackStartedAt = Date.now();
		void appendPerfEvent(deps, {
			phase: "playback",
			status: "started",
			turn: turnNumber,
			mode,
		});
		try {
			await deps.playAudio(file);
			void appendPerfEvent(deps, {
				phase: "playback",
				status: "ok",
				turn: turnNumber,
				mode,
				durationMs: Date.now() - playbackStartedAt,
			});
		} catch (err) {
			deps.logger.error("Playback error:", err);
			void appendPerfEvent(deps, {
				phase: "playback",
				status: "error",
				turn: turnNumber,
				mode,
				durationMs: Date.now() - playbackStartedAt,
				fields: {
					message: errorMessage(err, "Unknown playback error."),
				},
			});
		}
	} else {
		deps.logger.log("Playback skipped. Set HERZEN_PLAYBACK=1 to enable.");
		void appendPerfEvent(deps, {
			phase: "playback",
			status: "skipped",
			turn: turnNumber,
			mode,
			fields: {
				reason: "disabled",
			},
		});
	}

	if (shouldSpeak) {
		scheduleJournalHook(deps.logger, "Failed to write assistant utterance journal event", () =>
			deps.onAssistantUtterance?.({
				turn: turnNumber,
				text: speechText,
				ingressSource,
				language: speechLanguage,
				provider: llmProvider,
				model: llmModel,
			}),
		);
		const ttsStartedAt = Date.now();
		timeline.ttsStartedAtMs = ttsStartedAt;
		void appendPerfEvent(deps, {
			phase: "tts",
			status: "started",
			turn: turnNumber,
			mode,
			fields: {
				textChars: speechText.length,
			},
		});
		try {
			await deps.speak(speechText);
			timeline.ttsFinishedAtMs = Date.now();
			timeline.ttsFirstAudioSampleAtMs = timeline.ttsFinishedAtMs;
			void appendPerfEvent(deps, {
				phase: "tts",
				status: "ok",
				turn: turnNumber,
				mode,
				durationMs: Date.now() - ttsStartedAt,
				fields: {
					textChars: speechText.length,
				},
			});
		} catch (err) {
			deps.logger.error("TTS error:", err);
			timeline.ttsFinishedAtMs = Date.now();
			timeline.ttsFirstAudioSampleAtMs = timeline.ttsFinishedAtMs;
			void appendPerfEvent(deps, {
				phase: "tts",
				status: "error",
				turn: turnNumber,
				mode,
				durationMs: Date.now() - ttsStartedAt,
				fields: {
					message: errorMessage(err, "Unknown TTS error."),
				},
			});
		}
	} else {
		deps.logger.log("Follow-up no-speech fallback suppressed.");
		void appendPerfEvent(deps, {
			phase: "tts",
			status: "skipped",
			turn: turnNumber,
			mode,
			fields: {
				reason: "suppressed_no_speech",
			},
		});
	}
	deps.logger.log("Done:", file);

	void appendPerfEvent(deps, {
		phase: "turn",
		status: "ok",
		turn: turnNumber,
		mode,
		durationMs: Date.now() - turnStartedAt,
		fields: {
			hasTranscript: outcome.hasTranscript,
			assistantSource: outcome.assistantSource,
			llmOutcome: outcome.llmOutcome,
			errorCode,
		},
	});

	benchmarkErrorCode = benchmarkErrorCode ?? errorCode ?? llmErrorCode;
	await appendTurnBenchmark(deps, {
		schemaVersion: "turn_benchmark.v1",
		ts: deps.nowIso(),
		turn: turnNumber,
		triggerMode,
		invocationMode: mode,
		actionPath,
		language: classifyTurnLanguage(transcript, language),
		trigger_received: toIsoTimestamp(timeline.triggerReceivedAtMs),
		recording_started: toIsoTimestamp(timeline.recordingStartedAtMs),
		recording_finished: toIsoTimestamp(timeline.recordingFinishedAtMs),
		stt_started: toIsoTimestamp(timeline.sttStartedAtMs),
		stt_finished: toIsoTimestamp(timeline.sttFinishedAtMs),
		ha_intent_started: toIsoTimestamp(timeline.haIntentStartedAtMs),
		ha_intent_finished: toIsoTimestamp(timeline.haIntentFinishedAtMs),
		llm_started: toIsoTimestamp(timeline.llmStartedAtMs),
		llm_first_token: toIsoTimestamp(timeline.llmFirstTokenAtMs),
		llm_finished: toIsoTimestamp(timeline.llmFinishedAtMs),
		tts_started: toIsoTimestamp(timeline.ttsStartedAtMs),
		tts_first_audio_sample: toIsoTimestamp(timeline.ttsFirstAudioSampleAtMs),
		tts_finished: toIsoTimestamp(timeline.ttsFinishedAtMs),
		stt_ms: durationBetween(timeline.sttStartedAtMs, timeline.sttFinishedAtMs),
		ha_intent_ms: durationBetween(timeline.haIntentStartedAtMs, timeline.haIntentFinishedAtMs),
		llm_ms: durationBetween(timeline.llmStartedAtMs, timeline.llmFinishedAtMs),
		tts_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
		end_to_end_ms: durationBetween(timeline.triggerReceivedAtMs, timeline.ttsStartedAtMs),
		speak_tail_ms: durationBetween(timeline.ttsStartedAtMs, timeline.ttsFinishedAtMs),
		hasTranscript: outcome.hasTranscript,
		transcriptChars: transcript.length,
		llmOutcome: outcome.llmOutcome,
		errorCode: benchmarkErrorCode,
	});

	return outcome;
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
	options: {
		mode: TurnInvocationMode;
		remainingWindowSeconds: number | undefined;
	},
): Promise<RecordTurnAudioResult> {
	if (deps.recordingMode !== "adaptive") {
		deps.logger.log(`Triggered. Recording ${fixedSeconds.toFixed(1)} seconds…`);
		await deps.recordAudioFixed(file, fixedSeconds);
		return {
			strategy: "fixed",
			requestedSeconds: fixedSeconds,
			fallbackUsed: false,
		};
	}

	const adaptiveSettings = resolveAdaptiveRecordSettings(env, deps.logger, {
		followupNoSpeechTimeoutSeconds:
			options.mode === "followup" ? options.remainingWindowSeconds : undefined,
	});
	if (!adaptiveSettings) {
		deps.logger.log(`Triggered. Recording ${fixedSeconds.toFixed(1)} seconds…`);
		await deps.recordAudioFixed(file, fixedSeconds);
		return {
			strategy: "fixed",
			requestedSeconds: fixedSeconds,
			fallbackUsed: true,
			adaptiveError: "invalid_config",
		};
	}

	deps.logger.log("Triggered. Adaptive recording…");
	try {
		const adaptiveResult = await deps.recordAudioAdaptive(file, adaptiveSettings);
		deps.logger.log(
			`Adaptive stop: ${adaptiveResult.stopReason} (${adaptiveResult.durationSeconds.toFixed(2)}s).`,
		);
		return {
			strategy: "adaptive",
			requestedSeconds: fixedSeconds,
			fallbackUsed: false,
			capturedSeconds: adaptiveResult.durationSeconds,
			adaptiveStopReason: adaptiveResult.stopReason,
		};
	} catch (err) {
		deps.logger.error("Adaptive recording failed. Falling back to fixed recording for this turn.");
		if (err instanceof Error) {
			deps.logger.error(`Adaptive recording error: ${err.message}`);
		} else {
			deps.logger.error("Adaptive recording error:", err);
		}
		deps.logger.log(`Recording fallback ${fixedSeconds.toFixed(1)} seconds…`);
		await deps.recordAudioFixed(file, fixedSeconds);
		return {
			strategy: "fixed",
			requestedSeconds: fixedSeconds,
			fallbackUsed: true,
			adaptiveError: errorMessage(err, "Unknown adaptive recording error."),
		};
	}
}

function resolveAdaptiveRecordSettings(
	env: NodeJS.ProcessEnv,
	logger: TurnLogger,
	options: {
		followupNoSpeechTimeoutSeconds?: number;
	} = {},
): AdaptiveRecordSettings | null {
	try {
		let maxSeconds = resolvePositiveFiniteNumber(
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
		let noSpeechTimeoutSeconds = resolvePositiveFiniteNumber(
			env.HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS,
			DEFAULT_RECORD_NO_SPEECH_TIMEOUT_SECONDS,
			"HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS",
		);
		if (typeof options.followupNoSpeechTimeoutSeconds === "number") {
			noSpeechTimeoutSeconds = options.followupNoSpeechTimeoutSeconds;
			if (noSpeechTimeoutSeconds <= 0) {
				throw new Error("Follow-up recording window expired.");
			}
			maxSeconds = Math.max(maxSeconds, noSpeechTimeoutSeconds);
		}
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

function toRemainingWindowSeconds(remainingWindowMs: number | undefined): number | undefined {
	if (typeof remainingWindowMs !== "number") return undefined;
	if (!Number.isFinite(remainingWindowMs) || remainingWindowMs <= 0) return undefined;
	return remainingWindowMs / 1000;
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

function responseUnavailableLanguage(transcript: string, language: string): "en" | "ru" {
	return detectedLanguageLabel(transcript, language);
}

function responseUnavailableSpeech(transcript: string, language: string): string {
	if (responseUnavailableLanguage(transcript, language) === "ru") return RESPONSE_FALLBACK_SPEECH_RU;
	return RESPONSE_FALLBACK_SPEECH_EN;
}

function detectedLanguageLabel(transcript: string, language: string): "en" | "ru" {
	if (language.toLowerCase().startsWith("ru") || hasCyrillic(transcript)) return "ru";
	return "en";
}

function errorMessage(err: unknown, fallback: string): string {
	if (err instanceof Error && err.message.trim()) return err.message;
	if (typeof err === "object" && err !== null && "message" in err) {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message;
	}
	return fallback;
}

async function executeJournalHook(
	logger: TurnLogger,
	failureMessage: string,
	callback: (() => Promise<void> | void) | undefined,
): Promise<void> {
	if (!callback) return;
	try {
		await callback();
	} catch (err) {
		logger.error(`${failureMessage}:`, err);
	}
}

function scheduleJournalHook(
	logger: TurnLogger,
	failureMessage: string,
	callback: (() => Promise<void> | void) | undefined,
): void {
	void executeJournalHook(logger, failureMessage, callback);
}

async function appendPerfEvent(
	deps: TriggerTurnDependencies,
	event: {
		phase: "turn" | "record" | "stt" | "llm" | "tts" | "playback";
		status: "started" | "ok" | "error" | "skipped";
		turn: number;
		mode: TurnInvocationMode;
		durationMs?: number;
		fields?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		await deps.appendPerfEvent?.(event);
	} catch (err) {
		deps.logger.error("Failed to append perf event:", err);
	}
}

async function appendTurnBenchmark(
	deps: TriggerTurnDependencies,
	entry: TurnBenchmarkLogEntry,
): Promise<void> {
	try {
		await deps.appendTurnBenchmark?.(entry);
	} catch (err) {
		deps.logger.error("Failed to append turn benchmark event:", err);
	}
}

function durationBetween(startMs: number | undefined, endMs: number | undefined): number | undefined {
	if (typeof startMs !== "number" || typeof endMs !== "number") return undefined;
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
	const delta = endMs - startMs;
	return delta >= 0 ? delta : undefined;
}

function toIsoTimestamp(timestampMs: number | undefined): string | undefined {
	if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return undefined;
	return new Date(timestampMs).toISOString();
}

function inferActionPath(provider: string): Exclude<TurnBenchmarkActionPath, "none"> {
	if (provider === "home_assistant") return "home_assistant";
	return "llm";
}

function classifyTurnLanguage(transcript: string, detectedLanguage: string | undefined): TurnBenchmarkLanguage {
	const normalizedTranscript = transcript.trim();
	if (!normalizedTranscript) return "unknown";
	const hasRu = hasCyrillic(normalizedTranscript);
	const hasEn = hasLatin(normalizedTranscript);
	if (hasRu && hasEn) return "mixed";
	if (hasRu) return "ru";
	if (hasEn) return "en";

	const normalizedDetected = detectedLanguage?.trim().toLowerCase();
	if (normalizedDetected?.startsWith("ru")) return "ru";
	if (normalizedDetected?.startsWith("en")) return "en";
	return "unknown";
}

function hasLatin(text: string): boolean {
	return /[A-Za-z]/.test(text);
}

function resolveGenericErrorCode(err: unknown, fallback: string): string {
	if (typeof err === "object" && err !== null && "code" in err) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && code.trim()) return code;
	}
	return fallback;
}

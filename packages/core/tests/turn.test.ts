import { describe, expect, it, vi } from "vitest";
import {
	createSttTriggerHandler,
	type ResponseErrorLike,
	runTextTurn,
	runSttTurn,
	type SttErrorLike,
	type SttLogEntry,
	type TurnOutcome,
} from "../src/app/turn.js";

interface ContextItem {
	role: "user" | "assistant";
	text: string;
	language?: "en" | "ru";
	turn?: number;
}

function createNowMock(sequence: number[]) {
	let idx = 0;
	return vi.fn(() => {
		const value = sequence[Math.min(idx, sequence.length - 1)];
		idx += 1;
		return value;
	});
}

function createDeps(overrides?: {
	env?: NodeJS.ProcessEnv;
	nowSequence?: number[];
	recordingMode?: "fixed" | "adaptive";
	transcribeImpl?: (file: string) => Promise<{ text: string; language: string; durationMs: number }>;
	recordAdaptiveImpl?: (file: string, config: unknown) => Promise<{ durationSeconds: number; stopReason: string }>;
	playInputStartCueImpl?: () => Promise<void>;
	isSttError?: (err: unknown) => err is SttErrorLike;
	playAudioImpl?: (file: string) => Promise<void>;
	speakImpl?: (text: string) => Promise<void>;
		generateResponseImpl?: (input: {
			turn?: number;
			transcript: string;
			detectedLanguage?: string;
			requestedLanguage?: "auto" | "en" | "ru";
			timestampIso: string;
			conversationContext?: ContextItem[];
	}) => Promise<{
		text: string;
		language: "en" | "ru";
		provider: string;
		model: string;
		durationMs: number;
		actionPath?: "home_assistant" | "llm";
		haIntentStartedAtMs?: number;
		haIntentFinishedAtMs?: number;
		llmStartedAtMs?: number;
		llmFirstTokenAtMs?: number;
		llmFinishedAtMs?: number;
	}>;
	isResponseError?: (err: unknown) => err is ResponseErrorLike;
	conversationContext?: ContextItem[];
	onTurnOutcome?: (outcome: TurnOutcome) => Promise<void> | void;
}) {
	const logger = {
		log: vi.fn(),
		error: vi.fn(),
	};
	const now = createNowMock(overrides?.nowSequence ?? [1_000, 1_500, 2_000]);
	const appendSttLog = vi.fn(async (entry: SttLogEntry) => {
		void entry;
	});
	const playInputStartCue = overrides?.playInputStartCueImpl ?? vi.fn(async () => {});
	const recordAudioFixed = vi.fn(async () => {});
	const recordAudioAdaptive =
		overrides?.recordAdaptiveImpl ??
		vi.fn(async () => ({
			durationSeconds: 2.4,
			stopReason: "trailing_silence",
		}));
	const playAudio = overrides?.playAudioImpl ?? vi.fn(async () => {});
	const speak = overrides?.speakImpl ?? vi.fn(async () => {});
	const onUserUtterance = vi.fn(async () => {});
	const onAssistantUtterance = vi.fn(async () => {});
	const onError = vi.fn(async () => {});
	const appendTurnBenchmark = vi.fn(async () => {});
	const onTurnOutcome = overrides?.onTurnOutcome ?? vi.fn(async () => {});
	const getConversationContext = vi.fn(() => overrides?.conversationContext ?? []);
	const transcribeWav =
		overrides?.transcribeImpl ??
		(async () => ({ text: "hello there", language: "en", durationMs: 321 }));
	const isSttError =
		overrides?.isSttError ??
		((err: unknown): err is SttErrorLike =>
			typeof err === "object" && err !== null && "code" in err && "message" in err);
	const generateResponse =
		overrides?.generateResponseImpl ??
		vi.fn(async () => ({
			text: "Model reply",
			language: "en" as const,
			provider: "ollama",
			model: "qwen2.5:3b",
			durationMs: 210,
		}));
	const isResponseError =
		overrides?.isResponseError ??
		((err: unknown): err is ResponseErrorLike =>
			typeof err === "object" && err !== null && "code" in err && "message" in err);

	const deps = {
		outDir: "/tmp/audio",
		getEnv: () => overrides?.env ?? {},
		now,
		nowIso: () => "2026-02-14T00:00:00.000Z",
		logger,
		recordingMode: overrides?.recordingMode ?? "fixed",
		playInputStartCue,
		recordAudioFixed,
		recordAudioAdaptive,
		transcribeWav,
		isSttError,
		generateResponse,
		isResponseError,
		getConversationContext,
		onTurnOutcome,
		appendSttLog,
		onUserUtterance,
		onAssistantUtterance,
		onError,
		appendTurnBenchmark,
		playAudio,
		speak,
	};

	return {
		deps,
		logger,
		now,
		appendSttLog,
		playInputStartCue,
		recordAudioFixed,
		recordAudioAdaptive,
		playAudio,
		speak,
		onUserUtterance,
		onAssistantUtterance,
		onError,
		appendTurnBenchmark,
		onTurnOutcome,
		generateResponse,
		getConversationContext,
	};
}

describe("createSttTriggerHandler", () => {
	it("handles text ingress turns without audio capture", async () => {
		const {
			deps,
			recordAudioFixed,
			recordAudioAdaptive,
			playInputStartCue,
			playAudio,
			generateResponse,
			onUserUtterance,
			onAssistantUtterance,
			appendSttLog,
		} = createDeps({
			nowSequence: [1_000, 1_001, 1_002],
		});

		const outcome = await runTextTurn(deps, 7, "hello from tui", {
			mode: "trigger",
			triggerMode: "stdin",
			traceId: "trace-1",
			laneKey: "session:1:trigger",
		});

		expect(recordAudioFixed).not.toHaveBeenCalled();
		expect(recordAudioAdaptive).not.toHaveBeenCalled();
		expect(playInputStartCue).not.toHaveBeenCalled();
		expect(playAudio).not.toHaveBeenCalled();
		expect(generateResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 7,
				transcript: "hello from tui",
				control: {
					traceId: "trace-1",
					laneKey: "session:1:trigger",
				},
			}),
		);
		expect(onUserUtterance).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 7,
				text: "hello from tui",
				ingressSource: "tui",
			}),
		);
		expect(onAssistantUtterance).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 7,
				text: "Model reply",
				ingressSource: "tui",
			}),
		);
		expect(appendSttLog).toHaveBeenCalledWith(
			expect.objectContaining({
				audioFile: "control.ingress",
				transcript: "hello from tui",
			}),
		);
		expect(outcome).toMatchObject({
			turn: 7,
			hasTranscript: true,
			transcript: "hello from tui",
			assistantText: "Model reply",
			assistantSource: "model",
		});
	});

	it("handles successful STT result and speaks model reply", async () => {
		const {
			deps,
			logger,
			appendSttLog,
			playInputStartCue,
			recordAudioFixed,
			playAudio,
			speak,
			generateResponse,
			onUserUtterance,
			onAssistantUtterance,
			onTurnOutcome,
		} = createDeps({
			env: {
				HERZEN_STT_LANGUAGE: "en",
				HERZEN_RECORD_SECONDS: "5",
				HERZEN_PLAYBACK: "true",
			},
			transcribeImpl: async () => ({
				text: "hello world",
				language: "en",
				durationMs: 456,
			}),
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await handleTrigger();

		expect(playInputStartCue).toHaveBeenCalledTimes(1);
		expect(recordAudioFixed).toHaveBeenCalledWith("/tmp/audio/test-1000.wav", 5);
		expect(playAudio).toHaveBeenCalledWith("/tmp/audio/test-1000.wav");
			expect(generateResponse).toHaveBeenCalledWith({
				turn: 1,
				transcript: "hello world",
				detectedLanguage: "en",
				requestedLanguage: "en",
				timestampIso: "2026-02-14T00:00:00.000Z",
			});
		expect(onUserUtterance).toHaveBeenCalledWith({
			turn: 1,
			text: "hello world",
			ingressSource: "voice",
			detectedLanguage: "en",
			requestedLanguage: "en",
		});
		expect(onAssistantUtterance).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 1,
				text: "Model reply",
				ingressSource: "voice",
				language: "en",
				provider: "ollama",
				model: "qwen2.5:3b",
			}),
		);
		expect(speak).toHaveBeenCalledWith("Model reply");
		expect(logger.log).toHaveBeenCalledWith("[en detected]");
		expect(appendSttLog).toHaveBeenCalledWith({
			timestamp: "2026-02-14T00:00:00.000Z",
			audioFile: "/tmp/audio/test-1000.wav",
			durationMs: 456,
			latencyMs: 456,
			languageMode: "en",
			language: "en",
			transcript: "hello world",
			errorCode: undefined,
			llmProvider: "ollama",
			llmModel: "qwen2.5:3b",
			llmLatencyMs: 210,
			llmOutcome: "ok",
			llmErrorCode: undefined,
		});
		expect(onTurnOutcome).toHaveBeenCalledWith({
			turn: 1,
			hasTranscript: true,
			transcript: "hello world",
			detectedLanguage: "en",
			assistantText: "Model reply",
			assistantLanguage: "en",
			assistantSource: "model",
			llmOutcome: "ok",
		});
	});

	it("passes conversation context into response generation when available", async () => {
		const { deps, generateResponse, getConversationContext } = createDeps({
			transcribeImpl: async () => ({
				text: "What is my name?",
				language: "en",
				durationMs: 110,
			}),
			conversationContext: [
				{ role: "user", text: "My name is Pavel.", turn: 1 },
				{ role: "assistant", text: "Nice to meet you, Pavel.", turn: 1 },
			],
		});

		const handleTrigger = createSttTriggerHandler(deps);
		await handleTrigger();

		expect(getConversationContext).toHaveBeenCalledTimes(1);
			expect(generateResponse).toHaveBeenCalledWith({
				turn: 1,
				transcript: "What is my name?",
				detectedLanguage: "en",
				requestedLanguage: "auto",
				timestampIso: "2026-02-14T00:00:00.000Z",
				conversationContext: [
				{ role: "user", text: "My name is Pavel.", turn: 1 },
				{ role: "assistant", text: "Nice to meet you, Pavel.", turn: 1 },
			],
		});
	});

	it("writes per-turn benchmark entry with timestamp checkpoints and metrics", async () => {
		const triggerReceivedAtMs = 1_700_000_000_000;
		const { deps, appendTurnBenchmark } = createDeps({
			transcribeImpl: async () => ({
				text: "hello benchmark",
				language: "en",
				durationMs: 140,
			}),
		});

		await runSttTurn(deps, 1, {
			mode: "trigger",
			triggerMode: "wakeword",
			triggerReceivedAtMs,
		});

		expect(appendTurnBenchmark).toHaveBeenCalledTimes(1);
		const benchmarkEntry = appendTurnBenchmark.mock.calls[0]?.[0];
		expect(benchmarkEntry).toMatchObject({
			schemaVersion: "turn_benchmark.v1",
			turn: 1,
			triggerMode: "wakeword",
			invocationMode: "trigger",
			actionPath: "llm",
			language: "en",
			trigger_received: new Date(triggerReceivedAtMs).toISOString(),
			hasTranscript: true,
			transcriptChars: "hello benchmark".length,
			llmOutcome: "ok",
		});
		expect(benchmarkEntry.recording_started).toBeTypeOf("string");
		expect(benchmarkEntry.recording_finished).toBeTypeOf("string");
		expect(benchmarkEntry.stt_started).toBeTypeOf("string");
		expect(benchmarkEntry.stt_finished).toBeTypeOf("string");
		expect(benchmarkEntry.llm_started).toBeTypeOf("string");
		expect(benchmarkEntry.llm_finished).toBeTypeOf("string");
		expect(benchmarkEntry.tts_started).toBeTypeOf("string");
		expect(benchmarkEntry.tts_first_audio_sample).toBeTypeOf("string");
		expect(benchmarkEntry.tts_finished).toBeTypeOf("string");
		expect(typeof benchmarkEntry.stt_ms).toBe("number");
		expect(typeof benchmarkEntry.llm_ms).toBe("number");
		expect(typeof benchmarkEntry.tts_ms).toBe("number");
		expect(typeof benchmarkEntry.end_to_end_ms).toBe("number");
		expect(typeof benchmarkEntry.speak_tail_ms).toBe("number");
	});

	it("captures Home Assistant timing in benchmark when action path is home_assistant", async () => {
		const { deps, appendTurnBenchmark } = createDeps({
			generateResponseImpl: async () => ({
				text: "Done.",
				language: "en",
				provider: "home_assistant",
				model: "light.turn_on",
				durationMs: 85,
				actionPath: "home_assistant",
				haIntentStartedAtMs: 1000,
				haIntentFinishedAtMs: 1085,
			}),
		});

		await runSttTurn(deps, 1, {
			mode: "trigger",
			triggerMode: "stdin",
		});

		const benchmarkEntry = appendTurnBenchmark.mock.calls[0]?.[0];
		expect(benchmarkEntry).toMatchObject({
			actionPath: "home_assistant",
			ha_intent_started: new Date(1000).toISOString(),
			ha_intent_finished: new Date(1085).toISOString(),
			ha_intent_ms: 85,
		});
	});

	it("uses fallback speech when response generation fails", async () => {
		const responseErr = { code: "RUNTIME_UNAVAILABLE", message: "Ollama unavailable" };
		const { deps, logger, appendSttLog, speak, onError, onAssistantUtterance, onTurnOutcome } = createDeps({
			nowSequence: [2_000, 2_100, 2_400, 2_700],
			transcribeImpl: async () => ({
				text: "hello world",
				language: "en",
				durationMs: 123,
			}),
			generateResponseImpl: async () => {
				throw responseErr;
			},
			isResponseError: (err: unknown): err is ResponseErrorLike => err === responseErr,
		});

		const handleTrigger = createSttTriggerHandler(deps);
		await handleTrigger();

		expect(logger.error).toHaveBeenCalledWith("LLM response error (RUNTIME_UNAVAILABLE): Ollama unavailable");
		expect(onError).toHaveBeenCalledWith({
			turn: 1,
			stage: "response",
			code: "RUNTIME_UNAVAILABLE",
			message: "Ollama unavailable",
		});
		expect(onAssistantUtterance).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 1,
				text: "[en] I heard you, but I can't respond right now.",
				ingressSource: "voice",
				language: "en",
			}),
		);
		expect(speak).toHaveBeenCalledWith("[en] I heard you, but I can't respond right now.");
		expect(appendSttLog).toHaveBeenCalledWith(
			expect.objectContaining({
				llmOutcome: "error",
				llmErrorCode: "RUNTIME_UNAVAILABLE",
				llmLatencyMs: 300,
			}),
		);
		expect(onTurnOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantSource: "fallback",
				llmOutcome: "error",
				transcript: "hello world",
			}),
		);
	});

	it("uses russian response fallback when transcript language is russian", async () => {
		const responseErr = { code: "RUNTIME_UNAVAILABLE", message: "Ollama unavailable" };
		const { deps, speak } = createDeps({
			nowSequence: [2_000, 2_100, 2_400, 2_700],
			transcribeImpl: async () => ({
				text: "Привет",
				language: "ru",
				durationMs: 123,
			}),
			generateResponseImpl: async () => {
				throw responseErr;
			},
			isResponseError: (err: unknown): err is ResponseErrorLike => err === responseErr,
		});

		const handleTrigger = createSttTriggerHandler(deps);
		await handleTrigger();

		expect(speak).toHaveBeenCalledWith("[ru] Я вас услышал, но сейчас не могу ответить.");
	});

	it("uses fallback speech when transcript is empty", async () => {
		const { deps, logger, playAudio, speak, appendSttLog } = createDeps({
			transcribeImpl: async () => ({
				text: "   ",
				language: "en",
				durationMs: 120,
			}),
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await handleTrigger();

		expect(logger.log).toHaveBeenCalledWith("[no speech detected]");
		expect(playAudio).not.toHaveBeenCalled();
		expect(speak).toHaveBeenCalledWith("[en] I couldn't understand that.");
		expect(appendSttLog).toHaveBeenCalledWith(
			expect.objectContaining({
				transcript: undefined,
				errorCode: undefined,
				language: "en",
				llmOutcome: undefined,
			}),
		);
	});

	it("suppresses no-speech fallback in follow-up mode", async () => {
		const { deps, speak, onAssistantUtterance, appendSttLog, playInputStartCue } = createDeps({
			transcribeImpl: async () => ({
				text: " ",
				language: "en",
				durationMs: 120,
			}),
		});

		const outcome = await runSttTurn(deps, 1, {
			mode: "followup",
			suppressNoSpeechFallback: true,
			remainingWindowMs: 4_000,
		});

		expect(outcome.hasTranscript).toBe(false);
		expect(outcome.assistantText).toBe("");
		expect(playInputStartCue).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
		expect(onAssistantUtterance).not.toHaveBeenCalled();
		expect(appendSttLog).toHaveBeenCalledWith(
			expect.objectContaining({
				transcript: undefined,
			}),
		);
	});

	it("returns turn outcome even when playback fails", async () => {
		const playbackErr = new Error("device busy");
		const playAudioImpl = vi.fn(async () => {
			throw playbackErr;
		});
		const { deps, logger, speak, onTurnOutcome } = createDeps({
			env: { HERZEN_PLAYBACK: "1" },
			playAudioImpl,
			transcribeImpl: async () => ({
				text: "hello world",
				language: "en",
				durationMs: 456,
			}),
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await expect(handleTrigger()).resolves.toBeUndefined();

		expect(playAudioImpl).toHaveBeenCalledWith("/tmp/audio/test-1000.wav");
		expect(speak).toHaveBeenCalledWith("Model reply");
		expect(logger.error).toHaveBeenCalledWith("Playback error:", playbackErr);
		expect(onTurnOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 1,
				hasTranscript: true,
				transcript: "hello world",
			}),
		);
	});

	it("returns turn outcome even when TTS fails", async () => {
		const ttsErr = new Error("tts unavailable");
		const speakImpl = vi.fn(async () => {
			throw ttsErr;
		});
		const { deps, logger, onTurnOutcome } = createDeps({
			speakImpl,
			transcribeImpl: async () => ({
				text: "hello world",
				language: "en",
				durationMs: 456,
			}),
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await expect(handleTrigger()).resolves.toBeUndefined();

		expect(speakImpl).toHaveBeenCalledWith("Model reply");
		expect(logger.error).toHaveBeenCalledWith("TTS error:", ttsErr);
		expect(onTurnOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: 1,
				hasTranscript: true,
				transcript: "hello world",
			}),
		);
	});

	it("records typed STT error code and continues to fallback speech", async () => {
		const sttErr = { code: "MODEL_MISSING", message: "Model file missing" };
		const { deps, logger, appendSttLog, speak, onError } = createDeps({
			nowSequence: [3_000, 3_500, 3_800],
			transcribeImpl: async () => {
				throw sttErr;
			},
			isSttError: (err: unknown): err is SttErrorLike => err === sttErr,
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await handleTrigger();

		expect(logger.error).toHaveBeenCalledWith("STT error (MODEL_MISSING): Model file missing");
		expect(onError).toHaveBeenCalledWith({
			turn: 1,
			stage: "stt",
			code: "MODEL_MISSING",
			message: "Model file missing",
		});
		expect(appendSttLog).toHaveBeenCalledWith(
			expect.objectContaining({
				durationMs: 300,
				latencyMs: 300,
				errorCode: "MODEL_MISSING",
				transcript: undefined,
			}),
		);
		expect(speak).toHaveBeenCalledWith("[en] I couldn't understand that.");
	});

	it("maps unknown STT failures to UNKNOWN error code", async () => {
		const unknownErr = new Error("boom");
		const { deps, logger, appendSttLog, playAudio, speak } = createDeps({
			env: { HERZEN_PLAYBACK: "1" },
			nowSequence: [4_000, 4_010, 4_050],
			transcribeImpl: async () => {
				throw unknownErr;
			},
			isSttError: (err: unknown): err is SttErrorLike => {
				void err;
				return false;
			},
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await handleTrigger();

		expect(logger.error).toHaveBeenCalledWith("STT error:", unknownErr);
		expect(appendSttLog).toHaveBeenCalledWith(
			expect.objectContaining({
				errorCode: "UNKNOWN",
				durationMs: 40,
				latencyMs: 40,
			}),
		);
		expect(playAudio).toHaveBeenCalledWith("/tmp/audio/test-4000.wav");
		expect(speak).toHaveBeenCalledWith("[en] I couldn't understand that.");
	});

	it("uses adaptive recording mode and does not call fixed recorder on success", async () => {
		const { deps, recordAudioAdaptive, recordAudioFixed, logger } = createDeps({
			recordingMode: "adaptive",
			env: {
				HERZEN_RECORD_MIN_SECONDS: "1",
				HERZEN_RECORD_MAX_SECONDS: "6",
				HERZEN_RECORD_SILENCE_SECONDS: "0.6",
				HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS: "3",
				HERZEN_VAD_START_THRESHOLD: "0.6",
				HERZEN_VAD_END_THRESHOLD: "0.3",
				HERZEN_VAD_FRAME_SAMPLES: "512",
			},
		});

		const handleTrigger = createSttTriggerHandler(deps);
		await handleTrigger();

		expect(recordAudioAdaptive).toHaveBeenCalledWith(
			"/tmp/audio/test-1000.wav",
			expect.objectContaining({
				minSeconds: 1,
				maxSeconds: 6,
				silenceSeconds: 0.6,
				noSpeechTimeoutSeconds: 3,
				startThreshold: 0.6,
				endThreshold: 0.3,
				frameSamples: 512,
			}),
		);
		expect(recordAudioFixed).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith("Triggered. Adaptive recording…");
	});

	it("uses remaining follow-up window as fixed recording duration", async () => {
		const { deps, recordAudioFixed } = createDeps({
			recordingMode: "fixed",
			env: {
				HERZEN_RECORD_SECONDS: "3",
			},
			transcribeImpl: async () => ({
				text: "followup",
				language: "en",
				durationMs: 100,
			}),
		});

		await runSttTurn(deps, 1, {
			mode: "followup",
			remainingWindowMs: 8_000,
		});

		expect(recordAudioFixed).toHaveBeenCalledWith("/tmp/audio/test-1000.wav", 8);
	});

	it("uses remaining follow-up window for adaptive no-speech timeout", async () => {
		const { deps, recordAudioAdaptive } = createDeps({
			recordingMode: "adaptive",
			env: {
				HERZEN_RECORD_MIN_SECONDS: "1",
				HERZEN_RECORD_MAX_SECONDS: "12",
				HERZEN_RECORD_SILENCE_SECONDS: "0.6",
				HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS: "10",
				HERZEN_VAD_START_THRESHOLD: "0.6",
				HERZEN_VAD_END_THRESHOLD: "0.3",
				HERZEN_VAD_FRAME_SAMPLES: "512",
			},
			transcribeImpl: async () => ({
				text: "followup",
				language: "en",
				durationMs: 100,
			}),
		});

		await runSttTurn(deps, 1, {
			mode: "followup",
			remainingWindowMs: 3_000,
		});

		expect(recordAudioAdaptive).toHaveBeenCalledWith(
			"/tmp/audio/test-1000.wav",
			expect.objectContaining({
				noSpeechTimeoutSeconds: 3,
			}),
		);
	});

	it("does not shorten follow-up silence wait using adaptive defaults", async () => {
		const { deps, recordAudioAdaptive } = createDeps({
			recordingMode: "adaptive",
			env: {
				HERZEN_RECORD_MIN_SECONDS: "1",
				HERZEN_RECORD_MAX_SECONDS: "2",
				HERZEN_RECORD_SILENCE_SECONDS: "0.6",
				HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS: "1",
				HERZEN_VAD_START_THRESHOLD: "0.6",
				HERZEN_VAD_END_THRESHOLD: "0.3",
				HERZEN_VAD_FRAME_SAMPLES: "512",
			},
			transcribeImpl: async () => ({
				text: "followup",
				language: "en",
				durationMs: 100,
			}),
		});

		await runSttTurn(deps, 1, {
			mode: "followup",
			remainingWindowMs: 8_000,
		});

		expect(recordAudioAdaptive).toHaveBeenCalledWith(
			"/tmp/audio/test-1000.wav",
			expect.objectContaining({
				maxSeconds: 8,
				noSpeechTimeoutSeconds: 8,
			}),
		);
	});

	it("falls back to fixed recording when adaptive recording throws", async () => {
		const { deps, recordAudioAdaptive, recordAudioFixed, logger } = createDeps({
			recordingMode: "adaptive",
			env: {
				HERZEN_RECORD_SECONDS: "4",
			},
			recordAdaptiveImpl: vi.fn(async () => {
				throw new Error("vad unavailable");
			}),
		});

		const handleTrigger = createSttTriggerHandler(deps);
		await handleTrigger();

		expect(recordAudioAdaptive).toHaveBeenCalledTimes(1);
		expect(recordAudioFixed).toHaveBeenCalledWith("/tmp/audio/test-1000.wav", 4);
		expect(logger.error).toHaveBeenCalledWith(
			"Adaptive recording failed. Falling back to fixed recording for this turn.",
		);
		expect(logger.error).toHaveBeenCalledWith("Adaptive recording error: vad unavailable");
	});

	it("falls back to fixed recording when adaptive env config is invalid", async () => {
		const { deps, recordAudioAdaptive, recordAudioFixed, logger } = createDeps({
			recordingMode: "adaptive",
			env: {
				HERZEN_RECORD_SECONDS: "3",
				HERZEN_VAD_START_THRESHOLD: "0.2",
				HERZEN_VAD_END_THRESHOLD: "0.4",
			},
		});

		const handleTrigger = createSttTriggerHandler(deps);
		await handleTrigger();

		expect(recordAudioAdaptive).not.toHaveBeenCalled();
		expect(recordAudioFixed).toHaveBeenCalledWith("/tmp/audio/test-1000.wav", 3);
		expect(logger.error).toHaveBeenCalledWith(
			"Invalid adaptive recording config (HERZEN_VAD_END_THRESHOLD must be <= HERZEN_VAD_START_THRESHOLD.). Falling back to fixed recording for this turn.",
		);
	});
});

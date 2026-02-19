import { describe, expect, it, vi } from "vitest";
import { createSttTriggerHandler, type SttErrorLike, type SttLogEntry } from "../src/turn.js";

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
	isSttError?: (err: unknown) => err is SttErrorLike;
}) {
	const logger = {
		log: vi.fn(),
		error: vi.fn(),
	};
	const now = createNowMock(overrides?.nowSequence ?? [1_000, 1_500, 2_000]);
	const appendSttLog = vi.fn(async (entry: SttLogEntry) => {
		void entry;
	});
	const recordAudioFixed = vi.fn(async () => {});
	const recordAudioAdaptive =
		overrides?.recordAdaptiveImpl ??
		vi.fn(async () => ({
			durationSeconds: 2.4,
			stopReason: "trailing_silence",
		}));
	const playAudio = vi.fn(async () => {});
	const speak = vi.fn(async () => {});
	const transcribeWav =
		overrides?.transcribeImpl ??
		(async () => ({ text: "hello there", language: "en", durationMs: 321 }));
	const isSttError =
		overrides?.isSttError ??
		((err: unknown): err is SttErrorLike =>
			typeof err === "object" && err !== null && "code" in err && "message" in err);

	const deps = {
		outDir: "/tmp/audio",
		getEnv: () => overrides?.env ?? {},
		now,
		nowIso: () => "2026-02-14T00:00:00.000Z",
		logger,
		recordingMode: overrides?.recordingMode ?? "fixed",
		recordAudioFixed,
		recordAudioAdaptive,
		transcribeWav,
		isSttError,
		appendSttLog,
		playAudio,
		speak,
	};

	return {
		deps,
		logger,
		now,
		appendSttLog,
		recordAudioFixed,
		recordAudioAdaptive,
		playAudio,
		speak,
	};
}

describe("createSttTriggerHandler", () => {
	it("handles successful STT result and uses confirmation speech", async () => {
		const { deps, logger, appendSttLog, recordAudioFixed, playAudio, speak } = createDeps({
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

		expect(recordAudioFixed).toHaveBeenCalledWith("/tmp/audio/test-1000.wav", 5);
		expect(playAudio).toHaveBeenCalledWith("/tmp/audio/test-1000.wav");
		expect(speak).toHaveBeenCalledWith("[en] I heard: hello world");
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
		});
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
			}),
		);
	});

	it("records typed STT error code and continues to fallback speech", async () => {
		const sttErr = { code: "MODEL_MISSING", message: "Model file missing" };
		const { deps, logger, appendSttLog, speak } = createDeps({
			nowSequence: [3_000, 3_500, 3_800],
			transcribeImpl: async () => {
				throw sttErr;
			},
			isSttError: (err: unknown): err is SttErrorLike => err === sttErr,
		});
		const handleTrigger = createSttTriggerHandler(deps);

		await handleTrigger();

		expect(logger.error).toHaveBeenCalledWith("STT error (MODEL_MISSING): Model file missing");
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

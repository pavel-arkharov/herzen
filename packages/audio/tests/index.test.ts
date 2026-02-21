import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
	private listeners = new Map<string, Listener[]>();

	on(event: string, listener: Listener) {
		const next = this.listeners.get(event) ?? [];
		next.push(listener);
		this.listeners.set(event, next);
		return this;
	}

	once(event: string, listener: Listener) {
		const wrapped: Listener = (...args) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	off(event: string, listener: Listener) {
		const current = this.listeners.get(event) ?? [];
		this.listeners.set(
			event,
			current.filter((candidate) => candidate !== listener),
		);
		return this;
	}

	emit(event: string, ...args: unknown[]) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
}

class FakeChildProcess extends FakeEmitter {
	readonly stdout = new FakeEmitter();
	readonly stderr = new FakeEmitter();
	readonly kill = vi.fn((signal: NodeJS.Signals) => {
		this.killed = true;
		void signal;
		return true;
	});
	exitCode: number | null = null;
	killed = false;
}

const { spawnMock, writeFileMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	writeFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("node:fs/promises", () => ({
	writeFile: writeFileMock,
}));

import {
	AudioRecordError,
	beep,
	playAudio,
	playConversationClosedCue,
	playInputStartCue,
	recordAdaptiveWav,
	recordWav,
} from "../src/index.js";

function setupSpawn(): FakeChildProcess {
	const child = new FakeChildProcess();
	spawnMock.mockReturnValue(child);
	return child;
}

describe("audio command wrappers", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		writeFileMock.mockReset();
		writeFileMock.mockResolvedValue(undefined);
	});

	it("records wav with default sample rate", async () => {
		const child = setupSpawn();

		const pending = recordWav("/tmp/demo.wav", 5);
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith(
			"rec",
			["-q", "-c", "1", "/tmp/demo.wav", "trim", "0", "5", "rate", "-v", "16000"],
			{ stdio: "inherit" },
		);
	});

	it("plays audio file", async () => {
		const child = setupSpawn();

		const pending = playAudio("/tmp/demo.wav");
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("play", ["-q", "/tmp/demo.wav"], { stdio: "inherit" });
	});

	it("rejects when child process exits with non-zero code", async () => {
		const child = setupSpawn();

		const pending = beep();
		child.emit("exit", 2);

		await expect(pending).rejects.toThrow("play exited with code 2");
	});

	it("rejects when spawn emits an error", async () => {
		const child = setupSpawn();
		const err = new Error("spawn failed");

		const pending = beep();
		child.emit("error", err);

		await expect(pending).rejects.toBe(err);
	});

	it("plays a dampened start cue", async () => {
		const child = setupSpawn();

		const pending = playInputStartCue();
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith(
			"play",
			[
				"-q",
				"-n",
				"synth",
				"0.140",
				"sine",
				"720",
				"gain",
				"-14",
				"fade",
				"q",
				"0.006",
				"0.140",
				"0.055",
			],
			{ stdio: "inherit" },
		);
	});

	it("plays a two-note close cue", async () => {
		const childA = new FakeChildProcess();
		const childB = new FakeChildProcess();
		spawnMock.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

		const pending = playConversationClosedCue();
		childA.emit("exit", 0);
		while (spawnMock.mock.calls.length < 2) {
			await Promise.resolve();
		}
		childB.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenNthCalledWith(
			1,
			"play",
			[
				"-q",
				"-n",
				"synth",
				"0.080",
				"sine",
				"620",
				"gain",
				"-15",
				"fade",
				"q",
				"0.005",
				"0.080",
				"0.030",
			],
			{ stdio: "inherit" },
		);
		expect(spawnMock).toHaveBeenNthCalledWith(
			2,
			"play",
			[
				"-q",
				"-n",
				"synth",
				"0.120",
				"sine",
				"460",
				"gain",
				"-16",
				"fade",
				"q",
				"0.005",
				"0.120",
				"0.050",
			],
			{ stdio: "inherit" },
		);
	});

	it("adaptive recording stops on trailing silence after speech", async () => {
		const child = setupSpawn();
		child.kill.mockImplementation((signal: NodeJS.Signals) => {
			child.killed = true;
			setTimeout(() => {
				child.exitCode = 0;
				child.emit("close", 0, signal);
			}, 0);
			return true;
		});

		const vadSession = {
			reset: vi.fn(async () => {}),
			processFrame: vi
				.fn()
				.mockResolvedValueOnce(0.8)
				.mockResolvedValueOnce(0.8)
				.mockResolvedValueOnce(0.8)
				.mockResolvedValueOnce(0.9)
				.mockResolvedValueOnce(0.1)
				.mockResolvedValueOnce(0.1),
		};

		const pending = recordAdaptiveWav("/tmp/adaptive.wav", {
			vadSession,
			frameSamples: 4,
			sampleRate: 16,
			minSeconds: 1,
			maxSeconds: 4,
			silenceSeconds: 0.5,
			noSpeechTimeoutSeconds: 2,
			startThreshold: 0.55,
			endThreshold: 0.35,
		});

		await Promise.resolve();
		child.stdout.emit("data", Buffer.alloc(4 * 2 * 6));

		await expect(pending).resolves.toMatchObject({
			stopReason: "trailing_silence",
		});
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(vadSession.reset).toHaveBeenCalledTimes(1);
		expect(writeFileMock).toHaveBeenCalledWith("/tmp/adaptive.wav", expect.any(Buffer));
	});

	it("adaptive recording stops on no-speech timeout", async () => {
		const child = setupSpawn();
		child.kill.mockImplementation((signal: NodeJS.Signals) => {
			child.killed = true;
			setTimeout(() => {
				child.exitCode = 0;
				child.emit("close", 0, signal);
			}, 0);
			return true;
		});

		const vadSession = {
			reset: vi.fn(async () => {}),
			processFrame: vi.fn().mockResolvedValue(0.1),
		};

		const pending = recordAdaptiveWav("/tmp/adaptive.wav", {
			vadSession,
			frameSamples: 4,
			sampleRate: 16,
			minSeconds: 1,
			maxSeconds: 4,
			silenceSeconds: 0.5,
			noSpeechTimeoutSeconds: 0.75,
		});

		await Promise.resolve();
		child.stdout.emit("data", Buffer.alloc(4 * 2 * 3));

		await expect(pending).resolves.toMatchObject({
			stopReason: "no_speech_timeout",
		});
	});

	it("adaptive recording stops on max duration cap", async () => {
		const child = setupSpawn();
		child.kill.mockImplementation((signal: NodeJS.Signals) => {
			child.killed = true;
			setTimeout(() => {
				child.exitCode = 0;
				child.emit("close", 0, signal);
			}, 0);
			return true;
		});

		const vadSession = {
			reset: vi.fn(async () => {}),
			processFrame: vi.fn().mockResolvedValue(0.9),
		};

		const pending = recordAdaptiveWav("/tmp/adaptive.wav", {
			vadSession,
			frameSamples: 4,
			sampleRate: 16,
			minSeconds: 0.5,
			maxSeconds: 1,
			silenceSeconds: 0.5,
			noSpeechTimeoutSeconds: 3,
		});

		await Promise.resolve();
		child.stdout.emit("data", Buffer.alloc(4 * 2 * 4));

		await expect(pending).resolves.toMatchObject({
			stopReason: "max_seconds",
		});
	});

	it("sends SIGKILL when process does not close after SIGTERM", async () => {
		vi.useFakeTimers();
		try {
			const child = setupSpawn();
			child.kill.mockImplementation((signal: NodeJS.Signals) => {
				child.killed = true;
				if (signal === "SIGKILL") {
					child.exitCode = 0;
					child.emit("close", 0, signal);
				}
				return true;
			});

			const vadSession = {
				reset: vi.fn(async () => {}),
				processFrame: vi.fn().mockResolvedValue(0.1),
			};

			const pending = recordAdaptiveWav("/tmp/adaptive.wav", {
				vadSession,
				frameSamples: 4,
				sampleRate: 16,
				noSpeechTimeoutSeconds: 0.75,
				stopGraceMs: 10,
			});

			await Promise.resolve();
			child.stdout.emit("data", Buffer.alloc(4 * 2 * 3));
			await vi.advanceTimersByTimeAsync(11);

			await expect(pending).resolves.toMatchObject({
				stopReason: "no_speech_timeout",
			});
			expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
			expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects invalid adaptive threshold config", async () => {
		await expect(
			recordAdaptiveWav("/tmp/adaptive.wav", {
				startThreshold: 0.2,
				endThreshold: 0.3,
			}),
		).rejects.toMatchObject({
			name: "AudioRecordError",
			code: "CONFIG_INVALID",
		} satisfies Partial<AudioRecordError>);
	});

	it("rejects when rec exits non-zero even after stop condition", async () => {
		const child = setupSpawn();
		child.kill.mockImplementation((signal: NodeJS.Signals) => {
			child.killed = true;
			setTimeout(() => {
				child.exitCode = 2;
				child.emit("close", 2, signal);
			}, 0);
			return true;
		});

		const vadSession = {
			reset: vi.fn(async () => {}),
			processFrame: vi.fn().mockResolvedValue(0.1),
		};

		const pending = recordAdaptiveWav("/tmp/adaptive.wav", {
			vadSession,
			frameSamples: 4,
			sampleRate: 16,
			noSpeechTimeoutSeconds: 0.75,
		});

		await Promise.resolve();
		child.stdout.emit("data", Buffer.alloc(4 * 2 * 3));

		await expect(pending).rejects.toMatchObject({
			name: "AudioRecordError",
			code: "RECORD_FAILED",
		} satisfies Partial<AudioRecordError>);
		await expect(pending).rejects.toThrow("rec exited with code 2");
	});

	it("captures rec stderr details in failure messages", async () => {
		const child = setupSpawn();

		const pending = recordAdaptiveWav("/tmp/adaptive.wav", {
			vadSession: {
				reset: vi.fn(async () => {}),
				processFrame: vi.fn().mockResolvedValue(0.1),
			},
			frameSamples: 4,
			sampleRate: 16,
		});

		await Promise.resolve();
		child.stderr.emit("data", "mic read error");
		child.emit("close", 1, null);

		await expect(pending).rejects.toThrow("stderr: mic read error");
	});
});

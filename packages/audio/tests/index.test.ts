import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeStream {
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	on(event: string, listener: (...args: unknown[]) => void) {
		const next = this.listeners.get(event) ?? [];
		next.push(listener);
		this.listeners.set(event, next);
		return this;
	}

	emit(event: string, ...args: unknown[]) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
}

class FakeChildProcess {
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	readonly stderr = new FakeStream();
	readonly kill = vi.fn((signal?: NodeJS.Signals) => {
		void signal;
		return true;
	});

	on(event: string, listener: (...args: unknown[]) => void) {
		const next = this.listeners.get(event) ?? [];
		next.push(listener);
		this.listeners.set(event, next);
		return this;
	}

	emit(event: string, ...args: unknown[]) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import { beep, playAudio, recordWav, recordWavAdaptive } from "../src/index.js";

function setupSpawn(): FakeChildProcess {
	const child = new FakeChildProcess();
	spawnMock.mockReturnValue(child);
	return child;
}

describe("audio command wrappers", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		vi.useRealTimers();
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

	it("records adaptive wav with silence stop and deterministic resample", async () => {
		const child = setupSpawn();

		const pending = recordWavAdaptive("/tmp/adaptive.wav", {
			maxSeconds: 10,
			minSeconds: 0,
			silenceSeconds: 0.8,
			silenceThresholdPercent: 1,
			noSpeechTimeoutSeconds: 2.5,
		});
		child.stderr.emit("data", "In: 1.20% 00:00:00.20");
		child.emit("exit", 0, null);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith(
			"rec",
			[
				"-S",
				"-c",
				"1",
				"/tmp/adaptive.wav",
				"silence",
				"1",
				"0.10",
				"1%",
				"1",
				"0.8",
				"1%",
				"trim",
				"0",
				"10",
				"rate",
				"-v",
				"16000",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
	});

	it("fails adaptive recording when no speech is detected within timeout", async () => {
		vi.useFakeTimers();
		const child = setupSpawn();

		const pending = recordWavAdaptive("/tmp/no-speech.wav", {
			maxSeconds: 8,
			minSeconds: 1,
			silenceSeconds: 0.7,
			silenceThresholdPercent: 1,
			noSpeechTimeoutSeconds: 1.5,
		});
		child.stderr.emit("data", "In: 0.00% 00:00:00.10");

		vi.advanceTimersByTime(1_600);

		await expect(pending).rejects.toThrow("timed out waiting for speech");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		vi.advanceTimersByTime(600);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("keeps adaptive recording alive past no-speech timeout once speech is detected", async () => {
		vi.useFakeTimers();
		const child = setupSpawn();

		const pending = recordWavAdaptive("/tmp/speech.wav", {
			maxSeconds: 8,
			minSeconds: 0.5,
			silenceSeconds: 0.6,
			silenceThresholdPercent: 1,
			noSpeechTimeoutSeconds: 1,
		});
		child.stderr.emit("data", "In: 3.40% 00:00:00.40");
		vi.advanceTimersByTime(1_200);
		child.emit("exit", 0, null);

		await expect(pending).resolves.toBeUndefined();
		expect(child.kill).not.toHaveBeenCalled();
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
});

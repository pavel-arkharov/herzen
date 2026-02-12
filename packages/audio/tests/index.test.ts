import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeChildProcess {
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

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import { beep, playAudio, recordWav } from "../src/index.js";

function setupSpawn(): FakeChildProcess {
	const child = new FakeChildProcess();
	spawnMock.mockReturnValue(child);
	return child;
}

describe("audio command wrappers", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("records wav with default sample rate", async () => {
		const child = setupSpawn();

		const pending = recordWav("/tmp/demo.wav", 5);
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith(
			"rec",
			["-q", "-c", "1", "-r", "16000", "/tmp/demo.wav", "trim", "0", "5"],
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
});

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

import { listVoices, speak } from "../src/index.js";

function setupSpawn(): FakeChildProcess {
	const child = new FakeChildProcess();
	spawnMock.mockReturnValue(child);
	return child;
}

describe("tts command wrappers", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("speaks plain text", async () => {
		const child = setupSpawn();

		const pending = speak("hello");
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["hello"], { stdio: "inherit" });
	});

	it("infers Russian path from untagged Cyrillic text", async () => {
		const child = setupSpawn();

		const pending = speak("привет");
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["привет"], { stdio: "inherit" });
	});

	it("removes explicit language tag from spoken text", async () => {
		const child = setupSpawn();

		const pending = speak(" [ru] привет");
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["привет"], { stdio: "inherit" });
	});

	it("lists installed voices", async () => {
		const child = setupSpawn();

		const pending = listVoices();
		child.emit("exit", 0);

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["-v", "?"], { stdio: "inherit" });
	});

	it("rejects when say exits with non-zero code", async () => {
		const child = setupSpawn();

		const pending = speak("hello");
		child.emit("exit", 1);

		await expect(pending).rejects.toThrow("say exited with code 1");
	});

	it("rejects when spawn emits an error", async () => {
		const child = setupSpawn();
		const err = new Error("spawn failed");

		const pending = speak("hello");
		child.emit("error", err);

		await expect(pending).rejects.toBe(err);
	});
});

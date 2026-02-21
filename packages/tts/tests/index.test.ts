import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeStream {
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	readonly writes: string[] = [];
	readonly setEncoding = vi.fn(() => this);
	readonly end = vi.fn((chunk?: string | Buffer) => {
		if (typeof chunk !== "undefined") {
			this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		}
		this.emit("finish");
		return this;
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

class FakeChildProcess {
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	readonly stdin = new FakeStream();
	readonly stderr = new FakeStream();

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

const { spawnMock, mkdtempMock, writeFileMock, unlinkMock, rmMock, statMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	mkdtempMock: vi.fn(),
	writeFileMock: vi.fn(),
	unlinkMock: vi.fn(),
	rmMock: vi.fn(),
	statMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("node:fs/promises", () => ({
	mkdtemp: mkdtempMock,
	writeFile: writeFileMock,
	unlink: unlinkMock,
	rm: rmMock,
	stat: statMock,
}));

import { listVoices, speak } from "../src/index.js";

const TTS_ENV_KEYS = [
	"HERZEN_TTS_PROVIDER",
	"HERZEN_TTS_FALLBACK_PROVIDER",
	"HERZEN_TTS_XTTS_ENDPOINT",
	"HERZEN_TTS_XTTS_TIMEOUT_MS",
	"HERZEN_TTS_XTTS_VOICE_PROFILE",
	"HERZEN_ALLOW_REMOTE_TTS",
	"HERZEN_TTS_PIPER_MODEL_EN",
	"HERZEN_TTS_PIPER_MODEL_RU",
	"HERZEN_TTS_PIPER_CONFIG_EN",
	"HERZEN_TTS_PIPER_CONFIG_RU",
	"HERZEN_TTS_RATE_SCALE",
	"HERZEN_TTS_NOISE_SCALE",
	"HERZEN_TTS_NOISE_W",
] as const;

function setupSpawn(exitCode?: number): FakeChildProcess {
	const child = new FakeChildProcess();
	if (typeof exitCode === "number") {
		spawnMock.mockImplementationOnce(() => {
			queueMicrotask(() => {
				child.emit("exit", exitCode);
			});
			return child;
		});
	} else {
		spawnMock.mockReturnValueOnce(child);
	}
	return child;
}

function clearTtsEnv(): void {
	for (const key of TTS_ENV_KEYS) {
		delete process.env[key];
	}
}

describe("tts command wrappers", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		mkdtempMock.mockReset();
		writeFileMock.mockReset();
		unlinkMock.mockReset();
		rmMock.mockReset();
		statMock.mockReset();

		mkdtempMock.mockResolvedValue("/tmp/herzen-xtts-test");
		writeFileMock.mockResolvedValue(undefined);
		unlinkMock.mockResolvedValue(undefined);
		rmMock.mockResolvedValue(undefined);
		statMock.mockResolvedValue({ size: 10 });

		clearTtsEnv();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearTtsEnv();
	});

	it("speaks plain text with say by default", async () => {
		setupSpawn(0);

		const pending = speak("hello");

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["hello"], { stdio: "inherit" });
	});

	it("infers Russian path from untagged Cyrillic text", async () => {
		setupSpawn(0);

		const pending = speak("привет");

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["привет"], { stdio: "inherit" });
	});

	it("removes explicit language tag from spoken text", async () => {
		setupSpawn(0);

		const pending = speak(" [ru] привет");

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["привет"], { stdio: "inherit" });
	});

	it("lists installed voices", async () => {
		setupSpawn(0);

		const pending = listVoices();

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["-v", "?"], { stdio: "inherit" });
	});

	it("rejects when say exits with non-zero code", async () => {
		setupSpawn(1);

		const pending = speak("hello");

		await expect(pending).rejects.toThrow("say exited with code 1");
	});

	it("uses xtts provider with local endpoint and plays synthesized wav bytes", async () => {
		process.env.HERZEN_TTS_PROVIDER = "xtts";
		const fetchMock = vi.fn(async () => {
			return new Response(Buffer.from("wav-bytes"), {
				status: 200,
				headers: {
					"Content-Type": "audio/wav",
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		setupSpawn(0);

		const pending = speak("hello xtts");

		await expect(pending).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:8020/synthesize");
		expect(init.method).toBe("POST");
		const body = JSON.parse(String(init.body)) as {
			text: string;
			language: string;
			voiceProfile: string;
		};
		expect(body).toEqual({
			text: "hello xtts",
			language: "en",
			voiceProfile: "default",
		});

		expect(writeFileMock).toHaveBeenCalledWith("/tmp/herzen-xtts-test/speech.wav", expect.any(Buffer));
		expect(spawnMock).toHaveBeenCalledWith("play", ["-q", "/tmp/herzen-xtts-test/speech.wav"], {
			stdio: "inherit",
		});
		expect(unlinkMock).toHaveBeenCalledWith("/tmp/herzen-xtts-test/speech.wav");
		expect(rmMock).toHaveBeenCalledWith("/tmp/herzen-xtts-test", { recursive: true, force: true });
	});

	it("uses piper provider and writes utterance text to stdin", async () => {
		process.env.HERZEN_TTS_PROVIDER = "piper";
		process.env.HERZEN_TTS_PIPER_MODEL_EN = "/models/en.onnx";
		process.env.HERZEN_TTS_PIPER_CONFIG_EN = "/models/en.onnx.json";
		process.env.HERZEN_TTS_RATE_SCALE = "1.1";
		process.env.HERZEN_TTS_NOISE_SCALE = "0.6";
		process.env.HERZEN_TTS_NOISE_W = "0.9";

		const piperChild = setupSpawn(0);
		setupSpawn(0);

		await expect(speak("hello piper")).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenNthCalledWith(
			1,
			"piper",
			[
				"--model",
				"/models/en.onnx",
				"--output_file",
				"/tmp/herzen-xtts-test/speech.wav",
				"--config",
				"/models/en.onnx.json",
				"--length_scale",
				"1.1",
				"--noise_scale",
				"0.6",
				"--noise_w",
				"0.9",
			],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
		expect(piperChild.stdin.end).toHaveBeenCalledWith("hello piper\n");
		expect(statMock).toHaveBeenCalledWith("/tmp/herzen-xtts-test/speech.wav");
		expect(spawnMock).toHaveBeenNthCalledWith(2, "play", ["-q", "/tmp/herzen-xtts-test/speech.wav"], {
			stdio: "inherit",
		});
		expect(unlinkMock).toHaveBeenCalledWith("/tmp/herzen-xtts-test/speech.wav");
		expect(rmMock).toHaveBeenCalledWith("/tmp/herzen-xtts-test", { recursive: true, force: true });
	});

	it("uses ru piper model when text is tagged as russian", async () => {
		process.env.HERZEN_TTS_PROVIDER = "piper";
		process.env.HERZEN_TTS_PIPER_MODEL_RU = "/models/ru.onnx";

		setupSpawn(0);
		setupSpawn(0);

		await expect(speak("[ru] привет")).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenNthCalledWith(
			1,
			"piper",
			["--model", "/models/ru.onnx", "--output_file", "/tmp/herzen-xtts-test/speech.wav"],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
	});

	it("rejects piper provider when model env is missing", async () => {
		process.env.HERZEN_TTS_PROVIDER = "piper";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "piper";

		await expect(speak("hello")).rejects.toMatchObject({
			name: "TtsError",
			code: "CONFIG_INVALID",
			provider: "piper",
			stage: "config",
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("rejects invalid numeric piper knobs", async () => {
		process.env.HERZEN_TTS_PROVIDER = "piper";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "piper";
		process.env.HERZEN_TTS_PIPER_MODEL_EN = "/models/en.onnx";
		process.env.HERZEN_TTS_RATE_SCALE = "fast";

		await expect(speak("hello")).rejects.toMatchObject({
			name: "TtsError",
			code: "CONFIG_INVALID",
			provider: "piper",
			stage: "config",
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("maps non-zero piper exits to synthesis failures", async () => {
		process.env.HERZEN_TTS_PROVIDER = "piper";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "piper";
		process.env.HERZEN_TTS_PIPER_MODEL_EN = "/models/en.onnx";

		const piperChild = new FakeChildProcess();
		spawnMock.mockImplementationOnce(() => {
			queueMicrotask(() => {
				piperChild.stderr.emit("data", "model failed");
				piperChild.emit("exit", 3);
			});
			return piperChild;
		});

		await expect(speak("hello")).rejects.toMatchObject({
			name: "TtsError",
			code: "SYNTH_FAILED",
			provider: "piper",
			stage: "synthesize",
		});
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(statMock).not.toHaveBeenCalled();
	});

	it("falls back to say when piper fails", async () => {
		process.env.HERZEN_TTS_PROVIDER = "piper";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "say";
		process.env.HERZEN_TTS_PIPER_MODEL_EN = "/models/en.onnx";

		const piperChild = new FakeChildProcess();
		spawnMock.mockImplementationOnce(() => {
			queueMicrotask(() => {
				piperChild.stderr.emit("data", "runtime issue");
				piperChild.emit("exit", 1);
			});
			return piperChild;
		});
		setupSpawn(0);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(speak("hello fallback")).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenNthCalledWith(
			1,
			"piper",
			["--model", "/models/en.onnx", "--output_file", "/tmp/herzen-xtts-test/speech.wav"],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
		expect(spawnMock).toHaveBeenNthCalledWith(2, "say", ["hello fallback"], { stdio: "inherit" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects non-loopback xtts endpoints when remote override is off", async () => {
		process.env.HERZEN_TTS_PROVIDER = "xtts";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "xtts";
		process.env.HERZEN_TTS_XTTS_ENDPOINT = "http://192.168.1.33:8020";

		await expect(speak("hello")).rejects.toMatchObject({
			name: "TtsError",
			code: "CONFIG_INVALID",
			provider: "xtts",
			stage: "config",
		});

		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("maps xtts timeout/abort failures to runtime unavailable", async () => {
		process.env.HERZEN_TTS_PROVIDER = "xtts";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "xtts";

		const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw abortErr;
			}),
		);

		await expect(speak("hello")).rejects.toMatchObject({
			name: "TtsError",
			code: "RUNTIME_UNAVAILABLE",
			provider: "xtts",
			stage: "request",
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("rejects malformed xtts success payloads", async () => {
		process.env.HERZEN_TTS_PROVIDER = "xtts";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "xtts";

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify({ format: "wav" }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
					},
				});
			}),
		);

		await expect(speak("hello")).rejects.toMatchObject({
			name: "TtsError",
			code: "OUTPUT_INVALID",
			provider: "xtts",
			stage: "decode",
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("falls back to configured provider when xtts fails", async () => {
		process.env.HERZEN_TTS_PROVIDER = "xtts";
		process.env.HERZEN_TTS_FALLBACK_PROVIDER = "say";

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify({ error: "sidecar unavailable" }), {
					status: 503,
					headers: {
						"Content-Type": "application/json",
					},
				});
			}),
		);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		setupSpawn(0);

		const pending = speak("hello fallback");

		await expect(pending).resolves.toBeUndefined();
		expect(spawnMock).toHaveBeenCalledWith("say", ["hello fallback"], { stdio: "inherit" });
		expect(writeFileMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});

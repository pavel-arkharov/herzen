import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

class FakeStream {
	private listeners = new Map<string, Array<Listener>>();

	on(event: string, listener: Listener) {
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
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	readonly kill = vi.fn();
	private listeners = new Map<string, Array<Listener>>();

	on(event: string, listener: Listener) {
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

const mocks = vi.hoisted(() => {
	return {
		spawn: vi.fn(),
		access: vi.fn(),
		mkdtemp: vi.fn(),
		readFile: vi.fn(),
		rm: vi.fn(),
		tmpdir: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

vi.mock("node:fs/promises", () => ({
	access: mocks.access,
	mkdtemp: mocks.mkdtemp,
	readFile: mocks.readFile,
	rm: mocks.rm,
}));

vi.mock("node:os", () => ({
	tmpdir: mocks.tmpdir,
}));

import { transcribeWav } from "../src/index.js";

type SpawnPlanStep = (child: FakeChildProcess, cmd: string, args: string[]) => void;

function withSpawnPlan(steps: SpawnPlanStep[]) {
	const queue = [...steps];
	mocks.spawn.mockImplementation((command: string, args: string[]) => {
		const child = new FakeChildProcess();
		const step = queue.shift();
		if (!step) throw new Error(`No spawn plan step for command: ${command}`);
		queueMicrotask(() => step(child, command, args));
		return child;
	});
}

function closeWith(code: number | null, options?: { stdout?: string; stderr?: string }): SpawnPlanStep {
	return (child) => {
		if (options?.stdout) child.stdout.emit("data", options.stdout);
		if (options?.stderr) child.stderr.emit("data", options.stderr);
		child.emit("close", code);
	};
}

function failWith(err: Error): SpawnPlanStep {
	return (child) => {
		child.emit("error", err);
	};
}

describe("transcribeWav", () => {
	beforeEach(() => {
		mocks.spawn.mockReset();
		mocks.access.mockReset();
		mocks.mkdtemp.mockReset();
		mocks.readFile.mockReset();
		mocks.rm.mockReset();
		mocks.tmpdir.mockReset();

		delete process.env.HERZEN_WHISPER_BIN;
		delete process.env.HERZEN_WHISPER_MODEL;
		delete process.env.HERZEN_STT_LANGUAGE;
		delete process.env.HERZEN_STT_THREADS;

		mocks.access.mockResolvedValue(undefined);
		mocks.tmpdir.mockReturnValue("/tmp");
		mocks.mkdtemp.mockResolvedValue("/tmp/herzen-stt-test");
		mocks.readFile.mockResolvedValue(
			JSON.stringify({
				result: { language: "en" },
				transcription: [{ text: "hello" }, { text: "world" }],
			}),
		);
		mocks.rm.mockResolvedValue(undefined);
	});

	it("transcribes successfully and passes expected whisper arguments", async () => {
		process.env.HERZEN_WHISPER_BIN = "/custom/bin/my-whisper";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";
		process.env.HERZEN_STT_THREADS = "4";

		withSpawnPlan([
			closeWith(0, { stdout: "usage output" }),
			closeWith(0, { stdout: "ok" }),
		]);

		const result = await transcribeWav("/tmp/input.wav", {
			extraArgs: ["--temperature", "0"],
		});

		expect(result.text).toBe("hello world");
		expect(result.language).toBe("en");
		expect(result.backend).toBe("whisper.cpp");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(mocks.spawn).toHaveBeenNthCalledWith(
			2,
			"/custom/bin/my-whisper",
			expect.arrayContaining([
				"-m",
				"/models/ggml-base.bin",
				"-f",
				"/tmp/input.wav",
				"-l",
				"auto",
				"-oj",
				"-of",
				"/tmp/herzen-stt-test/transcript",
				"-t",
				"4",
				"--temperature",
				"0",
			]),
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		expect(mocks.rm).toHaveBeenCalledWith("/tmp/herzen-stt-test", { recursive: true, force: true });
	});

	it("returns MODEL_MISSING when model env var is not provided", async () => {
		process.env.HERZEN_WHISPER_BIN = "whisper-cli";

		withSpawnPlan([closeWith(0, { stdout: "whisper help" })]);

		await expect(transcribeWav("/tmp/input.wav")).rejects.toMatchObject({
			name: "SttError",
			code: "MODEL_MISSING",
		});
		expect(mocks.rm).not.toHaveBeenCalled();
	});

	it("returns RUNTIME_MISSING when whisper binary cannot be found", async () => {
		process.env.HERZEN_WHISPER_BIN = "/missing/whisper";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";

		const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
		withSpawnPlan([failWith(missing), failWith(missing)]);

		await expect(transcribeWav("/tmp/input.wav")).rejects.toMatchObject({
			name: "SttError",
			code: "RUNTIME_MISSING",
		});
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
	});

	it("returns TRANSCRIBE_FAILED for invalid thread env", async () => {
		process.env.HERZEN_WHISPER_BIN = "whisper-cli";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";
		process.env.HERZEN_STT_THREADS = "0";

		withSpawnPlan([closeWith(0, { stdout: "whisper help" })]);

		await expect(transcribeWav("/tmp/input.wav")).rejects.toMatchObject({
			name: "SttError",
			code: "TRANSCRIBE_FAILED",
		});
		expect(mocks.rm).not.toHaveBeenCalled();
	});

	it("falls back to parsing timestamped CLI output when JSON read fails", async () => {
		process.env.HERZEN_WHISPER_BIN = "whisper-cli";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";
		mocks.readFile.mockRejectedValue(new Error("missing JSON output"));

		withSpawnPlan([
			closeWith(0, { stdout: "whisper help" }),
			closeWith(0, {
				stdout: "[00:00:00.000 --> 00:00:01.500]   Hello   world   ",
			}),
		]);

		const result = await transcribeWav("/tmp/input.wav", { language: "en" });

		expect(result.text).toBe("Hello world");
		expect(result.language).toBe("en");
		expect(mocks.rm).toHaveBeenCalledWith("/tmp/herzen-stt-test", { recursive: true, force: true });
	});

	it("returns OUTPUT_PARSE_FAILED when JSON and fallback parsing both fail", async () => {
		process.env.HERZEN_WHISPER_BIN = "whisper-cli";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";
		mocks.readFile.mockRejectedValue(new Error("missing JSON output"));

		withSpawnPlan([
			closeWith(0, { stdout: "whisper help" }),
			closeWith(0, { stdout: "no transcript lines available" }),
		]);

		await expect(transcribeWav("/tmp/input.wav")).rejects.toMatchObject({
			name: "SttError",
			code: "OUTPUT_PARSE_FAILED",
		});
		expect(mocks.rm).toHaveBeenCalledWith("/tmp/herzen-stt-test", { recursive: true, force: true });
	});

	it("returns TRANSCRIBE_FAILED when transcription command exits non-zero", async () => {
		process.env.HERZEN_WHISPER_BIN = "whisper-cli";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";

		withSpawnPlan([
			closeWith(0, { stdout: "whisper help" }),
			closeWith(2, { stderr: "runtime failure" }),
		]);

		await expect(transcribeWav("/tmp/input.wav")).rejects.toMatchObject({
			name: "SttError",
			code: "TRANSCRIBE_FAILED",
			message: "whisper-cli exited with code 2.",
		});
		expect(mocks.rm).toHaveBeenCalledWith("/tmp/herzen-stt-test", { recursive: true, force: true });
	});

	it("wraps unexpected spawn error as TRANSCRIBE_FAILED", async () => {
		process.env.HERZEN_WHISPER_BIN = "whisper-cli";
		process.env.HERZEN_WHISPER_MODEL = "/models/ggml-base.bin";

		withSpawnPlan([
			closeWith(0, { stdout: "whisper help" }),
			failWith(new Error("spawn permission denied")),
		]);

		await expect(transcribeWav("/tmp/input.wav")).rejects.toMatchObject({
			name: "SttError",
			code: "TRANSCRIBE_FAILED",
		});
		expect(mocks.rm).toHaveBeenCalledWith("/tmp/herzen-stt-test", { recursive: true, force: true });
	});
});

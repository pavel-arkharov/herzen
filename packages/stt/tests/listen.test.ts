import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

class FakeChildProcess {
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
		mkdir: vi.fn(),
		readFile: vi.fn(),
		transcribeWav: vi.fn(),
		unlink: vi.fn(),
		writeFile: vi.fn(),
		transcribeFileToDocument: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

vi.mock("node:fs/promises", () => ({
	access: mocks.access,
	mkdir: mocks.mkdir,
	readFile: mocks.readFile,
	unlink: mocks.unlink,
	writeFile: mocks.writeFile,
}));

vi.mock("../src/document.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/document.js")>();
	return {
		...actual,
		transcribeFileToDocument: mocks.transcribeFileToDocument,
	};
});

vi.mock("../src/transcribe.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/transcribe.js")>();
	return {
		...actual,
		transcribeWav: mocks.transcribeWav,
	};
});

import { transcribeMicrophoneToDocument } from "../src/listen.js";

function buildMonoPcm16Wav(sampleRate: number, sampleCount: number): Buffer {
	const pcmData = Buffer.alloc(sampleCount * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcmData.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcmData.length, 40);
	return Buffer.concat([header, pcmData]);
}

function mockRecordingSuccess() {
	mocks.spawn.mockImplementation((_command: string, _args: string[]) => {
		const child = new FakeChildProcess();
		queueMicrotask(() => {
			child.emit("exit", 0);
		});
		return child;
	});
}

describe("transcribeMicrophoneToDocument", () => {
	beforeEach(() => {
		mocks.spawn.mockReset();
		mocks.access.mockReset();
		mocks.mkdir.mockReset();
		mocks.readFile.mockReset();
		mocks.transcribeWav.mockReset();
		mocks.unlink.mockReset();
		mocks.writeFile.mockReset();
		mocks.transcribeFileToDocument.mockReset();

		mocks.access.mockResolvedValue(undefined);
		mocks.mkdir.mockResolvedValue(undefined);
		mocks.readFile.mockResolvedValue(buildMonoPcm16Wav(16000, 1600));
		mocks.transcribeWav.mockResolvedValue({
			text: "hello world",
			language: "en",
			durationMs: 42,
			backend: "whisper.cpp",
		});
		mocks.unlink.mockResolvedValue(undefined);
		mocks.writeFile.mockResolvedValue(undefined);
		mocks.transcribeFileToDocument.mockResolvedValue({
			outputPath: "/repo/data/transcribes/mic-listen.txt",
			text: "hello world",
			language: "en",
			durationMs: 42,
			format: "txt",
		});
		mockRecordingSuccess();
	});

	it("records microphone audio into data/audio and writes txt output by default", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-31T09:10:11.000Z"));

		const result = await transcribeMicrophoneToDocument({
			durationSeconds: 90,
			language: "en",
			workingDir: "/repo",
		});

		expect(mocks.mkdir).toHaveBeenCalledWith("/repo/data/audio", { recursive: true });
		expect(mocks.spawn).toHaveBeenCalledWith(
			"rec",
			[
				"-q",
				"-c",
				"1",
				"/repo/data/audio/mic-listen-20260531T091011Z.wav",
				"trim",
				"0",
				"90",
				"rate",
				"-v",
				"16000",
			],
		);
		expect(mocks.transcribeFileToDocument).toHaveBeenCalledWith({
			inputPath: "/repo/data/audio/mic-listen-20260531T091011Z.wav",
			language: "en",
			format: "txt",
			outputPath: "/repo/data/transcribes/mic-listen-20260531T091011Z.txt",
			outputDir: undefined,
			outputName: "mic-listen",
			workingDir: "/repo",
		});
		expect(result).toMatchObject({
			audioPath: "/repo/data/audio/mic-listen-20260531T091011Z.wav",
			recordedSeconds: 90,
			outputPath: "/repo/data/transcribes/mic-listen.txt",
		});

		vi.useRealTimers();
	});

	it("honors explicit audio and transcript output settings", async () => {
		await transcribeMicrophoneToDocument({
			durationSeconds: 30,
			language: "auto",
			format: "md",
			outputPath: "data/transcribes/custom.md",
			outputName: "Quarterly Review",
			audioPath: "data/audio/review.wav",
			workingDir: "/repo",
		});

		expect(mocks.mkdir).toHaveBeenCalledWith("/repo/data/audio", { recursive: true });
		expect(mocks.spawn).toHaveBeenCalledWith(
			"rec",
			[
				"-q",
				"-c",
				"1",
				"/repo/data/audio/review.wav",
				"trim",
				"0",
				"30",
				"rate",
				"-v",
				"16000",
			],
		);
		expect(mocks.transcribeFileToDocument).toHaveBeenCalledWith({
			inputPath: "/repo/data/audio/review.wav",
			language: "auto",
			format: "md",
			outputPath: "/repo/data/transcribes/custom.md",
			outputDir: undefined,
			outputName: "Quarterly Review",
			workingDir: "/repo",
		});
	});

	it("supports until-stopped recording and rewrites the live transcript after SIGINT", async () => {
		const signalHandlers = new Map<string, Listener>();
		const onceSpy = vi
			.spyOn(process, "once")
			.mockImplementation(((event: string, handler: Listener) => {
				signalHandlers.set(event, handler);
				return process;
			}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((event: string, _handler: Listener) => {
				signalHandlers.delete(event);
				return process;
			}) as typeof process.removeListener);

		let child: FakeChildProcess | undefined;
		mocks.spawn.mockImplementation((_command: string, _args: string[]) => {
			child = new FakeChildProcess();
			mocks.access.mockImplementation(async (path: string) => {
				if (path.endsWith("0001.wav")) return undefined;
				throw new Error("ENOENT");
			});
			queueMicrotask(() => {
				signalHandlers.get("SIGINT")?.();
				queueMicrotask(() => {
					child?.emit("exit", null);
				});
			});
			return child;
		});

		const result = await transcribeMicrophoneToDocument({
			untilStopped: true,
			language: "auto",
			workingDir: "/repo",
		});

		expect(mocks.spawn).toHaveBeenCalledWith(
			"rec",
			[
				"-q",
				"-c",
				"1",
				"-r",
				"16000",
				"-b",
				"16",
				"-e",
				"signed-integer",
				"-t",
				"wavpcm",
				expect.stringMatching(/\/repo\/data\/audio\/mic-listen-\d{8}T\d{6}Z-%4n\.wav$/),
				"trim",
				"0",
				"30",
				":",
				"newfile",
				":",
				"restart",
			],
		);
		expect(child?.kill).toHaveBeenCalledWith("SIGINT");
		expect(mocks.transcribeWav).toHaveBeenCalledWith(expect.stringMatching(/0001\.wav$/), {
			language: "auto",
		});

		const transcriptWrites = mocks.writeFile.mock.calls.filter(
			([path]) => typeof path === "string" && path.endsWith(".txt"),
		);
		expect(transcriptWrites).toHaveLength(2);
		expect(transcriptWrites[0]).toEqual([
			expect.stringMatching(/\/repo\/data\/transcribes\/mic-listen-\d{8}T\d{6}Z\.txt$/),
			"",
			"utf8",
		]);
		expect(transcriptWrites[1]).toEqual([
			expect.stringMatching(/\/repo\/data\/transcribes\/mic-listen-\d{8}T\d{6}Z\.txt$/),
			"hello world\n",
			"utf8",
		]);
		expect(result.stopMode).toBe("until_stopped");
		expect(result.recordedSeconds).toBeUndefined();
		expect(result.chunkCount).toBe(1);
		expect(result.text).toBe("hello world");

		onceSpy.mockRestore();
		removeListenerSpy.mockRestore();
	});

	it("rewrites rolling transcript output with seam-aware overlap merges", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-31T10:11:12.000Z"));

		mocks.spawn.mockImplementation((_command: string, _args: string[]) => {
			const child = new FakeChildProcess();
			queueMicrotask(() => {
				child.emit("exit", 0);
			});
			return child;
		});
		mocks.access.mockImplementation(async (path: string) => {
			if (
				path === "/repo/data/audio/live-session-20260531T101112Z-0001.wav" ||
				path === "/repo/data/audio/live-session-20260531T101112Z-0002.wav"
			) {
				return undefined;
			}
			throw new Error("ENOENT");
		});
		mocks.readFile.mockImplementation(async (path: string) => {
			if (path.endsWith("0001.wav")) return buildMonoPcm16Wav(16000, 1600);
			if (path.endsWith("0002.wav")) return buildMonoPcm16Wav(16000, 3200);
			throw new Error(`ENOENT: ${path}`);
		});
		mocks.transcribeWav
			.mockResolvedValueOnce({
				text: "Hello I'm talking in engl",
				language: "en",
				durationMs: 1000,
				backend: "whisper.cpp",
			})
			.mockResolvedValueOnce({
				text: "english and switching to Russian.",
				language: "en",
				durationMs: 1200,
				backend: "whisper.cpp",
			});

		const result = await transcribeMicrophoneToDocument({
			durationSeconds: 60,
			chunkSeconds: 30,
			language: "en",
			outputName: "live-session",
			workingDir: "/repo",
		});

		expect(mocks.transcribeWav).toHaveBeenNthCalledWith(
			1,
			"/repo/data/audio/live-session-20260531T101112Z-0001.wav",
			{ language: "en" },
		);
		expect(mocks.transcribeWav).toHaveBeenNthCalledWith(
			2,
			"/repo/data/audio/live-session-20260531T101112Z-0002-context.wav",
			{ language: "en" },
		);
		expect(mocks.unlink).toHaveBeenCalledWith(
			"/repo/data/audio/live-session-20260531T101112Z-0002-context.wav",
		);

		const transcriptWrites = mocks.writeFile.mock.calls.filter(
			([path]) =>
				path === "/repo/data/transcribes/live-session-20260531T101112Z.txt" &&
				typeof path === "string",
		);
		expect(transcriptWrites).toEqual([
			["/repo/data/transcribes/live-session-20260531T101112Z.txt", "", "utf8"],
			[
				"/repo/data/transcribes/live-session-20260531T101112Z.txt",
				"Hello I'm talking in engl\n",
				"utf8",
			],
			[
				"/repo/data/transcribes/live-session-20260531T101112Z.txt",
				"Hello I'm talking in english and switching to Russian.\n",
				"utf8",
			],
		]);
		expect(result).toMatchObject({
			outputPath: "/repo/data/transcribes/live-session-20260531T101112Z.txt",
			audioPath: "/repo/data/audio/live-session-20260531T101112Z-%4n.wav",
			recordedSeconds: 60,
			stopMode: "duration",
			chunkCount: 2,
			text: "Hello I'm talking in english and switching to Russian.",
			durationMs: 300,
		});

		vi.useRealTimers();
	});

	it("rejects invalid duration values early", async () => {
		await expect(
			transcribeMicrophoneToDocument({
				durationSeconds: 0,
			}),
		).rejects.toMatchObject({
			name: "SttError",
			code: "TRANSCRIBE_FAILED",
			message: 'Invalid microphone duration "0". Expected a positive number of seconds.',
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});

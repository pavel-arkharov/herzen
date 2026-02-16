import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	return {
		access: vi.fn(),
		mkdir: vi.fn(),
		writeFile: vi.fn(),
		transcribeWav: vi.fn(),
	};
});

vi.mock("node:fs/promises", () => ({
	access: mocks.access,
	mkdir: mocks.mkdir,
	writeFile: mocks.writeFile,
}));

vi.mock("../src/transcribe.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/transcribe.js")>();
	return {
		...actual,
		transcribeWav: mocks.transcribeWav,
	};
});

import { transcribeFileToDocument } from "../src/document.js";

describe("transcribeFileToDocument", () => {
	beforeEach(() => {
		mocks.access.mockReset();
		mocks.mkdir.mockReset();
		mocks.writeFile.mockReset();
		mocks.transcribeWav.mockReset();

		mocks.access.mockResolvedValue(undefined);
		mocks.mkdir.mockResolvedValue(undefined);
		mocks.writeFile.mockResolvedValue(undefined);
		mocks.transcribeWav.mockResolvedValue({
			text: "hello world",
			language: "en",
			backend: "whisper.cpp",
			durationMs: 42,
		});
	});

	it("writes txt output as plain transcript text", async () => {
		const result = await transcribeFileToDocument({
			inputPath: "/tmp/audio/sample.wav",
			language: "en",
			format: "txt",
			outputPath: "/tmp/transcribes/out.txt",
		});

		expect(mocks.transcribeWav).toHaveBeenCalledWith("/tmp/audio/sample.wav", { language: "en" });
		expect(mocks.mkdir).toHaveBeenCalledWith("/tmp/transcribes", { recursive: true });
		expect(mocks.writeFile).toHaveBeenCalledWith("/tmp/transcribes/out.txt", "hello world\n", "utf8");
		expect(result).toMatchObject({
			outputPath: "/tmp/transcribes/out.txt",
			text: "hello world",
			language: "en",
			durationMs: 42,
			format: "txt",
		});
	});

	it("writes md output with metadata block and transcript section", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-15T12:34:56.000Z"));

		await transcribeFileToDocument({
			inputPath: "/tmp/audio/source.wav",
			language: "ru",
			format: "md",
			outputPath: "/tmp/transcribes/out.md",
		});

		const content = String(mocks.writeFile.mock.calls[0]?.[1] ?? "");
		expect(content).toContain("# Transcript");
		expect(content).toContain("- Source file path: `/tmp/audio/source.wav`");
		expect(content).toContain("- Language mode requested: `ru`");
		expect(content).toContain("- Detected language: `en`");
		expect(content).toContain("- Generated timestamp: `2026-02-15T12:34:56.000Z`");
		expect(content).toContain("## Transcript");
		expect(content).toContain("hello world");

		vi.useRealTimers();
	});

	it("generates default output path under workingDir data/transcribes directory", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-15T01:02:03.000Z"));

		const result = await transcribeFileToDocument({
			inputPath: "audio/My Sample.wav",
			workingDir: "/Users/parkharo/Programming/herzen",
		});

		expect(result.outputPath).toBe(
			"/Users/parkharo/Programming/herzen/data/transcribes/my-sample-20260215T010203Z.md",
		);
		expect(mocks.mkdir).toHaveBeenCalledWith("/Users/parkharo/Programming/herzen/data/transcribes", {
			recursive: true,
		});
		expect(mocks.transcribeWav).toHaveBeenCalledWith(
			"/Users/parkharo/Programming/herzen/audio/My Sample.wav",
			{ language: "auto" },
		);

		vi.useRealTimers();
	});

	it("rejects when input file does not exist", async () => {
		mocks.access.mockRejectedValue(new Error("ENOENT"));

		await expect(
			transcribeFileToDocument({
				inputPath: "/tmp/audio/missing.wav",
			}),
		).rejects.toMatchObject({
			name: "SttError",
			code: "TRANSCRIBE_FAILED",
			message: "Input file not found: /tmp/audio/missing.wav",
		});
		expect(mocks.transcribeWav).not.toHaveBeenCalled();
	});
});

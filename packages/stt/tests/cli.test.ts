import { describe, expect, it, vi } from "vitest";
import { parseCliArgs, runCli } from "../src/cli.js";
import { SttError } from "../src/transcribe.js";

describe("stt cli", () => {
	it("rejects invalid format arguments with usage output", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn();

		const exitCode = await runCli(["--input", "/tmp/audio.wav", "--format", "pdf"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(1);
		expect(transcribe).not.toHaveBeenCalled();
		const message = String(stderr.error.mock.calls[0]?.[0] ?? "");
		expect(message).toContain('Invalid --format value "pdf"');
		expect(message).toContain("Usage:");
	});

	it("rejects invalid language arguments with usage output", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn();

		const exitCode = await runCli(["--input", "/tmp/audio.wav", "--lang", "de"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(1);
		expect(transcribe).not.toHaveBeenCalled();
		const message = String(stderr.error.mock.calls[0]?.[0] ?? "");
		expect(message).toContain('Invalid --lang value "de"');
		expect(message).toContain("Usage:");
	});

	it("returns non-zero and emits concise error when transcription fails", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn().mockRejectedValue(
			new SttError("TRANSCRIBE_FAILED", "Input file not found: /tmp/missing.wav"),
		);

		const exitCode = await runCli(["--input", "/tmp/missing.wav"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(1);
		expect(stderr.error).toHaveBeenCalledWith("Input file not found: /tmp/missing.wav");
		expect(stdout.log).not.toHaveBeenCalled();
	});

	it("accepts positional input path", () => {
		const parsed = parseCliArgs(["/tmp/audio.wav", "--lang", "ru", "--format", "txt"]);
		expect(parsed).toMatchObject({
			inputPath: "/tmp/audio.wav",
			language: "ru",
			format: "txt",
		});
	});

	it("passes INIT_CWD-derived workingDir to transcribe helper", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn().mockResolvedValue({ outputPath: "/repo/data/transcribes/out.md" });
		const originalInitCwd = process.env.INIT_CWD;
		process.env.INIT_CWD = "/repo";

		const exitCode = await runCli(["voice.m4a"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(0);
		expect(transcribe).toHaveBeenCalledWith(
			expect.objectContaining({
				inputPath: "voice.m4a",
				workingDir: "/repo",
			}),
		);

		if (originalInitCwd === undefined) {
			delete process.env.INIT_CWD;
		} else {
			process.env.INIT_CWD = originalInitCwd;
		}
	});
});

import { describe, expect, it, vi } from "vitest";
import { parseListenCliArgs, runListenCli } from "../src/listen_cli.js";
import { SttError } from "../src/transcribe.js";

describe("stt listen cli", () => {
	it("rejects missing duration arguments with usage output", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn();

		const exitCode = await runListenCli(["--lang", "en"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(1);
		expect(transcribe).not.toHaveBeenCalled();
		const message = String(stderr.error.mock.calls[0]?.[0] ?? "");
		expect(message).toContain("Missing required capture mode");
		expect(message).toContain("Usage:");
	});

	it("rejects invalid duration values with usage output", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn();

		const exitCode = await runListenCli(["--duration-minutes", "0"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(1);
		expect(transcribe).not.toHaveBeenCalled();
		const message = String(stderr.error.mock.calls[0]?.[0] ?? "");
		expect(message).toContain('Invalid --duration-minutes value "0"');
		expect(message).toContain("Usage:");
	});

	it("parses duration minutes and defaults to english txt mode", () => {
		const parsed = parseListenCliArgs(["--duration-minutes", "53"]);
		expect(parsed).toMatchObject({
			durationSeconds: 3180,
			untilStopped: false,
			chunkSeconds: undefined,
			language: "en",
			format: "txt",
		});
	});

	it("parses rolling chunk settings for fixed-duration capture", () => {
		const parsed = parseListenCliArgs([
			"--duration-seconds",
			"90",
			"--chunk-seconds",
			"15",
			"--lang",
			"auto",
		]);
		expect(parsed).toMatchObject({
			durationSeconds: 90,
			untilStopped: false,
			chunkSeconds: 15,
			language: "auto",
			format: "txt",
		});
	});

	it("parses until-stopped mode without a duration", () => {
		const parsed = parseListenCliArgs(["--until-stopped", "--lang", "auto"]);
		expect(parsed).toMatchObject({
			durationSeconds: undefined,
			untilStopped: true,
			chunkSeconds: undefined,
			language: "auto",
			format: "txt",
		});
	});

	it("passes INIT_CWD-derived workingDir to the transcription helper", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn().mockResolvedValue({
			outputPath: "/repo/data/transcribes/out.txt",
			audioPath: "/repo/data/audio/in.wav",
		});
		const originalInitCwd = process.env.INIT_CWD;
		process.env.INIT_CWD = "/repo";

		const exitCode = await runListenCli(["--duration-seconds", "90", "--lang", "en"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(0);
		expect(transcribe).toHaveBeenCalledWith(
			expect.objectContaining({
				durationSeconds: 90,
				untilStopped: false,
				chunkSeconds: undefined,
				language: "en",
				format: "txt",
				workingDir: "/repo",
			}),
		);

		if (originalInitCwd === undefined) {
			delete process.env.INIT_CWD;
		} else {
			process.env.INIT_CWD = originalInitCwd;
		}
	});

	it("returns concise STT errors from the microphone helper", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn().mockRejectedValue(
			new SttError("TRANSCRIBE_FAILED", "Microphone recording failed: rec exited with code 1"),
		);

		const exitCode = await runListenCli(["--duration-seconds", "30"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(1);
		expect(stderr.error).toHaveBeenCalledWith(
			"Microphone recording failed: rec exited with code 1",
		);
	});

	it("passes until-stopped through to the microphone helper", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn().mockResolvedValue({
			outputPath: "/repo/data/transcribes/out.txt",
			audioPath: "/repo/data/audio/in.wav",
		});

		const exitCode = await runListenCli(["--until-stopped", "--lang", "auto"], {
			stdout,
			stderr,
			transcribe,
		});

		expect(exitCode).toBe(0);
		expect(transcribe).toHaveBeenCalledWith(
			expect.objectContaining({
				durationSeconds: undefined,
				untilStopped: true,
				chunkSeconds: undefined,
				language: "auto",
				format: "txt",
			}),
		);
		expect(stdout.log).toHaveBeenCalledWith(
			"Recording microphone until stopped in 30s chunks. Press Ctrl+C once to stop recording and finalize transcription...",
		);
	});

	it("announces rolling live chunks for fixed-duration capture", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const transcribe = vi.fn().mockResolvedValue({
			outputPath: "/repo/data/transcribes/out.txt",
			audioPath: "/repo/data/audio/in-%4n.wav",
		});

		const exitCode = await runListenCli(
			["--duration-seconds", "120", "--chunk-seconds", "20", "--lang", "en"],
			{
				stdout,
				stderr,
				transcribe,
			},
		);

		expect(exitCode).toBe(0);
		expect(transcribe).toHaveBeenCalledWith(
			expect.objectContaining({
				durationSeconds: 120,
				untilStopped: false,
				chunkSeconds: 20,
				language: "en",
			}),
		);
		expect(stdout.log).toHaveBeenCalledWith(
			"Recording microphone for 120.0s with 20.0s live chunks...",
		);
	});
});

import { describe, expect, it, vi } from "vitest";
import { parseHerzenCliArgs, runHerzenCli } from "../src/herzen_cli.js";

describe("herzen cli", () => {
	it("parses explicit transcribe flags", () => {
		const parsed = parseHerzenCliArgs([
			"transcribe",
			"--duration",
			"53m",
			"--chunk",
			"300",
			"--output",
			"secure-player-live.txt",
			"--lang",
			"en",
		]);

		expect(parsed).toMatchObject({
			subcommand: "transcribe",
			durationInput: "53m",
			untilStopped: false,
			chunkSeconds: 300,
			output: "secure-player-live.txt",
			language: "en",
		});
	});

	it("prompts for missing duration, chunk, and output", async () => {
		const stdout = { log: vi.fn() };
		const stderr = { error: vi.fn() };
		const runListen = vi.fn().mockResolvedValue(0);
		const prompt = vi
			.fn<(_: string) => Promise<string>>()
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("secure-player-live");

		const exitCode = await runHerzenCli(["transcribe"], {
			runListen,
			stdout,
			stderr,
			isTty: true,
			prompt,
			now: () => new Date("2026-06-01T08:09:10.000Z"),
		});

		expect(exitCode).toBe(0);
		expect(runListen).toHaveBeenCalledWith([
			"--until-stopped",
			"--chunk-seconds",
			"60",
			"--lang",
			"auto",
			"--format",
			"txt",
			"--out",
			"data/transcribes/secure-player-live.txt",
			"--name",
			"secure-player-live",
		]);
		expect(prompt).toHaveBeenNthCalledWith(
			1,
			"Duration [until-stopped] (examples: 2m, 53m, 120s, 02:00): ",
		);
	});

	it("supports until-stopped with direct flags", async () => {
		const runListen = vi.fn().mockResolvedValue(0);
		const exitCode = await runHerzenCli(
			["transcribe", "--until-stopped", "--chunk", "45", "--output", "mixed.md", "--lang", "auto"],
			{
				runListen,
				stdout: { log: vi.fn() },
				stderr: { error: vi.fn() },
				isTty: false,
				prompt: vi.fn(),
				now: () => new Date("2026-06-01T08:09:10.000Z"),
			},
		);

		expect(exitCode).toBe(0);
		expect(runListen).toHaveBeenCalledWith([
			"--until-stopped",
			"--chunk-seconds",
			"45",
			"--lang",
			"auto",
			"--format",
			"md",
			"--out",
			"data/transcribes/mixed.md",
			"--name",
			"mixed",
		]);
	});

	it("fails cleanly without a tty when duration is missing", async () => {
		const stderr = { error: vi.fn() };
		const exitCode = await runHerzenCli(["transcribe"], {
			runListen: vi.fn(),
			stdout: { log: vi.fn() },
			stderr,
			isTty: false,
			prompt: vi.fn(),
			now: () => new Date("2026-06-01T08:09:10.000Z"),
		});

		expect(exitCode).toBe(1);
		expect(String(stderr.error.mock.calls[0]?.[0] ?? "")).toContain("Missing capture mode");
	});

	it("rejects unknown subcommands", async () => {
		const stderr = { error: vi.fn() };
		const exitCode = await runHerzenCli(["banana"], {
			runListen: vi.fn(),
			stdout: { log: vi.fn() },
			stderr,
			isTty: false,
			prompt: vi.fn(),
			now: () => new Date("2026-06-01T08:09:10.000Z"),
		});

		expect(exitCode).toBe(1);
		expect(String(stderr.error.mock.calls[0]?.[0] ?? "")).toContain("Unknown subcommand");
	});
});

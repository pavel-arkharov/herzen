import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, toStructuredSttTurnEntry } from "../src/logging.js";

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
	try {
		const raw = await readFile(file, "utf8");
		const lines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("createLogger", () => {
	it("reads level and transcript flags from env and applies defaults", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "herzen-logs-env-"));
		const consoleTarget = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

		try {
			vi.stubEnv("HERZEN_LOG_LEVEL", "error");
			vi.stubEnv("HERZEN_LOG_TRANSCRIPT", "1");
			const fromEnv = createLogger({ logsDir, component: "core", consoleTarget });
			expect(fromEnv.level).toBe("error");
			expect(fromEnv.transcriptEnabled).toBe(true);

			vi.stubEnv("HERZEN_LOG_LEVEL", "");
			vi.stubEnv("HERZEN_LOG_TRANSCRIPT", "");
			const fromDefaults = createLogger({ logsDir, component: "core", consoleTarget });
			expect(fromDefaults.level).toBe("info");
			expect(fromDefaults.transcriptEnabled).toBe(false);
		} finally {
			await rm(logsDir, { recursive: true, force: true });
		}
	});

	it("filters runtime entries by level and writes structured jsonl", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "herzen-logs-level-"));
		const consoleTarget = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

		try {
			const logger = createLogger({
				logsDir,
				component: "core",
				level: "warn",
				consoleTarget,
				nowIso: () => "2026-02-14T00:00:00.000Z",
			});

			logger.info("core.ignored", { message: "skip me", attempt: 1 });
			logger.warn("core.warned", { message: "warn line", attempt: 2 });
			await logger.drain();

			const entries = await readJsonl(join(logsDir, "runtime.jsonl"));
			expect(entries).toEqual([
				{
					ts: "2026-02-14T00:00:00.000Z",
					level: "warn",
					component: "core",
					event: "core.warned",
					message: "warn line",
					fields: { attempt: 2 },
				},
			]);
			expect(consoleTarget.log).not.toHaveBeenCalled();
			expect(consoleTarget.warn).toHaveBeenCalledWith("warn line", { attempt: 2 });
		} finally {
			await rm(logsDir, { recursive: true, force: true });
		}
	});

	it("rejects invalid stream names to prevent path escape", async () => {
		const parentDir = await mkdtemp(join(tmpdir(), "herzen-logs-stream-"));
		const logsDir = join(parentDir, "logs");
		const consoleTarget = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

		try {
			const logger = createLogger({ logsDir, component: "core", consoleTarget });
			await logger.appendJsonl("../escape", { escaped: true });
			await logger.drain();

			await expect(access(join(parentDir, "escape.jsonl"), constants.F_OK)).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(consoleTarget.warn).toHaveBeenCalledWith(
				expect.stringContaining("Refused to write invalid stream"),
				undefined,
			);
		} finally {
			await rm(parentDir, { recursive: true, force: true });
		}
	});

	it("does not throw when append paths fail", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "herzen-logs-failure-"));
		const logsDir = join(rootDir, "not-a-dir");
		const consoleTarget = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
		await writeFile(logsDir, "file-blocks-directory", "utf8");

		try {
			const logger = createLogger({ logsDir, component: "core", consoleTarget });
			await expect(logger.appendJsonl("runtime", { ok: true })).resolves.toBeUndefined();
			expect(() => logger.error("core.failed", { message: "still alive" })).not.toThrow();
			await logger.drain();
			expect(consoleTarget.warn).toHaveBeenCalled();
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	it("drain waits for writes queued during an active flush", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "herzen-logs-drain-"));
		const consoleTarget = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

		try {
			const logger = createLogger({ logsDir, component: "core", consoleTarget });
			const firstWrite = logger.appendJsonl("runtime", { seq: 1 });
			void firstWrite.then(() => logger.appendJsonl("runtime", { seq: 2 }));

			await logger.drain();

			const entries = await readJsonl(join(logsDir, "runtime.jsonl"));
			expect(entries).toEqual([{ seq: 1 }, { seq: 2 }]);
		} finally {
			await rm(logsDir, { recursive: true, force: true });
		}
	});
});

describe("toStructuredSttTurnEntry", () => {
	it("gates transcript field based on transcriptEnabled", () => {
		const baseEntry = {
			timestamp: "2026-02-14T00:00:00.000Z",
			audioFile: "/tmp/audio/test.wav",
			durationMs: 222,
			latencyMs: 250,
			languageMode: "auto",
			language: "en",
			transcript: "hello world",
			errorCode: undefined,
		};

		const withoutTranscript = toStructuredSttTurnEntry(baseEntry, { transcriptEnabled: false });
		expect(withoutTranscript).toMatchObject({
			ts: "2026-02-14T00:00:00.000Z",
			level: "info",
			component: "stt",
			event: "stt.turn",
			fields: {
				audioFile: "/tmp/audio/test.wav",
				latencyMs: 250,
				durationMs: 222,
				languageMode: "auto",
				detectedLanguage: "en",
			},
		});
		expect(withoutTranscript.fields).not.toHaveProperty("transcript");

		const withTranscript = toStructuredSttTurnEntry(baseEntry, { transcriptEnabled: true });
		expect(withTranscript.fields).toHaveProperty("transcript", "hello world");
	});

	it("marks llm failures as error level even without STT error code", () => {
		const entry = toStructuredSttTurnEntry(
			{
				timestamp: "2026-02-14T00:00:00.000Z",
				audioFile: "/tmp/audio/test.wav",
				durationMs: 222,
				latencyMs: 250,
				languageMode: "auto",
				language: "en",
				transcript: "hello",
				errorCode: undefined,
				llmOutcome: "error",
				llmErrorCode: "RUNTIME_UNAVAILABLE",
			},
			{ transcriptEnabled: false },
		);

		expect(entry.level).toBe("error");
		expect(entry.fields).toMatchObject({
			llmOutcome: "error",
			llmErrorCode: "RUNTIME_UNAVAILABLE",
		});
	});
});

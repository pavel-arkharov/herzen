import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDialogJournal } from "../src/conversation/journal.js";

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
	const raw = await readFile(file, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createDialogJournal", () => {
	it("writes session events once and appends markdown dialogue", async () => {
		const conversationsDir = await mkdtemp(join(tmpdir(), "herzen-dialog-"));
		const nowIso = vi
			.fn()
			.mockReturnValueOnce("2026-02-20T10:00:00.000Z")
			.mockReturnValueOnce("2026-02-20T10:00:01.000Z")
			.mockReturnValueOnce("2026-02-20T10:00:02.000Z")
			.mockReturnValueOnce("2026-02-20T10:00:03.000Z")
			.mockReturnValueOnce("2026-02-20T10:00:04.000Z")
			.mockReturnValueOnce("2026-02-20T10:00:05.000Z")
			.mockReturnValue("2026-02-20T10:00:06.000Z");

		try {
			const journal = createDialogJournal({
				conversationsDir,
				sessionId: "session-test",
				nowIso,
			});

			await journal.recordSessionStarted({
				provider: "ollama",
				model: "qwen2.5:3b",
				temperature: 0.2,
				responseTimeoutMs: 12000,
				triggerMode: "stdin",
				recordingMode: "fixed",
				sttLanguageMode: "auto",
			});
			await journal.recordSessionStarted({
				provider: "ignored",
				model: "ignored",
				temperature: 0.1,
				responseTimeoutMs: 1,
				triggerMode: "ignored",
				recordingMode: "ignored",
				sttLanguageMode: "ignored",
			});
			await journal.recordUserUtterance({
				turn: 1,
				text: "Turn off kitchen lights",
				detectedLanguage: "en",
				requestedLanguage: "en",
			});
			await journal.recordActionCall({
				turn: 1,
				integration: "home_assistant",
				operation: "light.turn_off",
				args: { entity_id: "light.kitchen" },
			});
			await journal.recordActionResult({
				turn: 1,
				integration: "home_assistant",
				operation: "light.turn_off",
				result: { success: true },
			});
			await journal.recordAssistantUtterance({
				turn: 1,
				text: "Done.",
				language: "en",
				provider: "ollama",
				model: "qwen2.5:3b",
			});
			await journal.recordSessionEnded({ reason: "normal_shutdown" });
			await journal.drain();

			const jsonlPath = join(conversationsDir, "session-test.jsonl");
			const mdPath = join(conversationsDir, "session-test.md");
			const pointerPath = join(conversationsDir, "current_session");
			const events = await readJsonl(jsonlPath);
			const markdown = await readFile(mdPath, "utf8");
			const pointer = await readFile(pointerPath, "utf8");

			expect(events.map((event) => event.type)).toEqual([
				"session_started",
				"user_utterance",
				"action_call",
				"action_result",
				"assistant_utterance",
				"session_ended",
			]);
			expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
			expect(events[0]).toMatchObject({
				schemaVersion: "dialog.v1",
				sessionId: "session-test",
				type: "session_started",
				settings: {
					provider: "ollama",
					model: "qwen2.5:3b",
				},
			});
			expect(markdown).toContain("# Herzen Session session-test");
			expect(markdown).toContain("## Session Settings");
			expect(markdown).toContain("### Turn 1");
			expect(markdown).toContain("User: Turn off kitchen lights");
			expect(markdown).toContain("Herzen: Done.");
			expect(markdown).toContain("```json");
			expect(markdown).toContain('"type":"action_call"');
			expect(pointer.trim()).toBe("session-test");
		} finally {
			await rm(conversationsDir, { recursive: true, force: true });
		}
	});

	it("can be disabled with HERZEN_LOG_DIALOG=0 style config", async () => {
		const conversationsDir = await mkdtemp(join(tmpdir(), "herzen-dialog-off-"));
		const warn = vi.fn();

		try {
			const journal = createDialogJournal({
				conversationsDir,
				enabled: "0",
				consoleTarget: { warn },
			});

			await journal.recordSessionStarted({
				provider: "ollama",
				model: "qwen2.5:3b",
				temperature: 0.2,
				responseTimeoutMs: 12000,
				triggerMode: "stdin",
				recordingMode: "fixed",
				sttLanguageMode: "auto",
			});
			await journal.recordUserUtterance({ turn: 1, text: "hello" });
			await journal.recordAssistantUtterance({ turn: 1, text: "hi" });
			await journal.recordSessionEnded();
			await journal.drain();

			await expect(readFile(join(conversationsDir, `${journal.sessionId}.jsonl`), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(warn).not.toHaveBeenCalled();
		} finally {
			await rm(conversationsDir, { recursive: true, force: true });
		}
	});

	it("never throws on write failures", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "herzen-dialog-fail-"));
		const blockedPath = join(rootDir, "conversations");
		const warn = vi.fn();
		await writeFile(blockedPath, "not a directory", "utf8");

		try {
			const journal = createDialogJournal({
				conversationsDir: blockedPath,
				consoleTarget: { warn },
			});

			await expect(
				journal.recordSessionStarted({
					provider: "ollama",
					model: "qwen2.5:3b",
					temperature: 0.2,
					responseTimeoutMs: 12000,
					triggerMode: "stdin",
					recordingMode: "fixed",
					sttLanguageMode: "auto",
				}),
			).resolves.toBeUndefined();
			await expect(journal.recordUserUtterance({ turn: 1, text: "hello" })).resolves.toBeUndefined();
			await expect(journal.recordAssistantUtterance({ turn: 1, text: "hi" })).resolves.toBeUndefined();
			await expect(journal.recordError({ turn: 1, stage: "response", message: "fail" })).resolves.toBeUndefined();
			await expect(journal.recordSessionEnded()).resolves.toBeUndefined();
			await journal.drain();
			expect(warn).toHaveBeenCalled();
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});
});

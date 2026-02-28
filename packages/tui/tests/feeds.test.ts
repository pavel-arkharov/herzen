import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createFeedReaders } from "../src/feeds.js";

function createTempRoot(prefix: string): string {
	const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

describe("tui feeds", () => {
	it("loads session entries and advances incrementally", async () => {
		const root = createTempRoot("tui-session");
		const conversationsDir = join(root, "conversations");
		mkdirSync(conversationsDir, { recursive: true });
		writeFileSync(join(conversationsDir, "current_session"), "session-1\n", "utf8");
		const sessionFile = join(conversationsDir, "session-1.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "user_utterance", turn: 1, text: "hello", ts: "t1" }),
				JSON.stringify({ type: "assistant_utterance", turn: 1, text: "hi", ts: "t2" }),
			].join("\n") + "\n",
			"utf8",
		);

		const readers = createFeedReaders(root, { sessionLimit: 10 });
		const first = await readers.pollSessionFeed();
		expect(first).toEqual([
			{ role: "user", turn: 1, text: "hello", ts: "t1" },
			{ role: "assistant", turn: 1, text: "hi", ts: "t2" },
		]);

		appendFileSync(
			sessionFile,
			`${JSON.stringify({ type: "user_utterance", turn: 2, text: "next", ts: "t3" })}\n`,
			"utf8",
		);
		const second = await readers.pollSessionFeed();
		expect(second).toEqual([
			{ role: "user", turn: 1, text: "hello", ts: "t1" },
			{ role: "assistant", turn: 1, text: "hi", ts: "t2" },
			{ role: "user", turn: 2, text: "next", ts: "t3" },
		]);
	});

	it("keeps active session reader when current_session pointer temporarily disappears", async () => {
		const root = createTempRoot("tui-session-sticky");
		const conversationsDir = join(root, "conversations");
		mkdirSync(conversationsDir, { recursive: true });
		writeFileSync(join(conversationsDir, "current_session"), "session-1\n", "utf8");
		const sessionFile = join(conversationsDir, "session-1.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "user_utterance", turn: 1, text: "hello", ts: "t1", ingressSource: "tui" })}\n`,
			"utf8",
		);

		const readers = createFeedReaders(root, { sessionLimit: 10 });
		expect(await readers.pollSessionFeed()).toEqual([
			{ role: "user", turn: 1, text: "hello", ts: "t1", ingressSource: "tui" },
		]);

		unlinkSync(join(conversationsDir, "current_session"));
		appendFileSync(
			sessionFile,
			`${JSON.stringify({ type: "assistant_utterance", turn: 1, text: "hi", ts: "t2", ingressSource: "tui" })}\n`,
			"utf8",
		);
		expect(await readers.pollSessionFeed()).toEqual([
			{ role: "user", turn: 1, text: "hello", ts: "t1", ingressSource: "tui" },
			{ role: "assistant", turn: 1, text: "hi", ts: "t2", ingressSource: "tui" },
		]);
	});

	it("loads action feed and aggregates perf summary with last turn timing", async () => {
		const root = createTempRoot("tui-action");
		const controlDir = join(root, "control");
		const logsDir = join(root, "logs");
		mkdirSync(controlDir, { recursive: true });
		mkdirSync(logsDir, { recursive: true });

		writeFileSync(
			join(controlDir, "execution.jsonl"),
			[
				JSON.stringify({
					turn: 1,
					phase: "ingress_accepted",
					ok: true,
					details: { ingressId: "ing-1", source: "tui" },
					ts: "t0",
				}),
				JSON.stringify({ turn: 1, phase: "command_started", ok: true, ts: "t1" }),
				JSON.stringify({ turn: 1, phase: "command_failed", ok: false, code: "REQUEST_FAILED", ts: "t2" }),
			].join("\n") + "\n",
			"utf8",
		);
		writeFileSync(
			join(controlDir, "core_status.json"),
			JSON.stringify({
				schemaVersion: "core.status.v1",
				sessionId: "session-1",
				profile: "hybrid",
				coreState: "ready",
				lastHeartbeatTs: new Date().toISOString(),
				triggerState: "ready",
				wakewordState: "disabled",
				sttState: "ready",
				ttsState: "ready",
			}),
			"utf8",
		);

		writeFileSync(
			join(logsDir, "perf.jsonl"),
			[
				JSON.stringify({ phase: "stt", durationMs: 120 }),
				JSON.stringify({ phase: "stt", durationMs: 80 }),
				JSON.stringify({ phase: "llm", durationMs: 300 }),
			].join("\n") + "\n",
			"utf8",
		);

		writeFileSync(
			join(logsDir, "turn_benchmark.jsonl"),
			JSON.stringify({
				schemaVersion: "turn_benchmark.v1",
				turn: 1,
				stt_ms: 140,
				llm_ms: 310,
				tts_ms: 90,
				end_to_end_ms: 650,
				actionPath: "llm",
				language: "en",
			}) + "\n",
			"utf8",
		);

		const readers = createFeedReaders(root, { actionLimit: 10, perfLimit: 50 });
		const actions = await readers.pollActionFeed();
		expect(actions).toHaveLength(3);
		expect(actions[0]).toMatchObject({
			phase: "ingress_accepted",
			ingressId: "ing-1",
			ingressSource: "tui",
		});
		expect(actions[2]).toMatchObject({ phase: "command_failed", code: "REQUEST_FAILED" });

		const perf = await readers.pollPerfSummary();
		expect(perf.totalEvents).toBe(3);
		expect(perf.phases).toEqual([
			{ phase: "stt", count: 2, avgDurationMs: 100 },
			{ phase: "llm", count: 1, avgDurationMs: 300 },
		]);
		expect(perf.lastTurn).toMatchObject({
			turn: 1,
			sttMs: 140,
			llmMs: 310,
			ttsMs: 90,
			endToEndMs: 650,
		});

		const coreStatus = await readers.pollCoreStatus();
		expect(coreStatus.online).toBe(true);
		expect(coreStatus.status).toMatchObject({
			sessionId: "session-1",
			profile: "hybrid",
			coreState: "ready",
		});
	});
});

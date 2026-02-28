import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedReaders } from "./feeds.js";

function createTempRoot(prefix: string): string {
	const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

async function main(): Promise<void> {
	const root = createTempRoot("herzen-tui-bench");
	const conversationsDir = join(root, "conversations");
	const controlDir = join(root, "control");
	const logsDir = join(root, "logs");
	mkdirSync(conversationsDir, { recursive: true });
	mkdirSync(controlDir, { recursive: true });
	mkdirSync(logsDir, { recursive: true });

	writeFileSync(join(conversationsDir, "current_session"), "session-1\n", "utf8");
	writeFileSync(join(conversationsDir, "session-1.jsonl"), "", "utf8");
	writeFileSync(join(controlDir, "execution.jsonl"), "", "utf8");
	writeFileSync(join(logsDir, "perf.jsonl"), "", "utf8");
	writeFileSync(join(logsDir, "turn_benchmark.jsonl"), "", "utf8");

	const readers = createFeedReaders(root);
	await readers.pollSessionFeed();
	await readers.pollActionFeed();
	await readers.pollPerfSummary();

	const idleIterations = 250;
	const idleStart = process.hrtime.bigint();
	for (let i = 0; i < idleIterations; i += 1) {
		await readers.pollSessionFeed();
		await readers.pollActionFeed();
		if (i % 6 === 0) await readers.pollPerfSummary();
	}
	const idleDurationMs = Number(process.hrtime.bigint() - idleStart) / 1_000_000;

	const burstCount = 200;
	const burstStart = process.hrtime.bigint();
	for (let i = 0; i < burstCount; i += 1) {
		appendFileSync(
			join(conversationsDir, "session-1.jsonl"),
			`${JSON.stringify({ type: "user_utterance", turn: i + 1, text: `msg-${i}`, ingressSource: "tui" })}\n`,
			"utf8",
		);
		appendFileSync(
			join(controlDir, "execution.jsonl"),
			`${JSON.stringify({ phase: "ingress_accepted", ok: true, details: { ingressId: `ing-${i}`, source: "tui" } })}\n`,
			"utf8",
		);
		await readers.pollSessionFeed();
		await readers.pollActionFeed();
		if (i % 8 === 0) await readers.pollPerfSummary();
	}
	const burstDurationMs = Number(process.hrtime.bigint() - burstStart) / 1_000_000;

	process.stdout.write(
		[
			`TUI feed benchmark root: ${root}`,
			`Idle loop: ${idleIterations} iterations in ${idleDurationMs.toFixed(2)}ms (${(idleDurationMs / idleIterations).toFixed(3)}ms/iter)`,
			`Append burst: ${burstCount} iterations in ${burstDurationMs.toFixed(2)}ms (${(burstDurationMs / burstCount).toFixed(3)}ms/iter)`,
			"",
		].join("\n"),
	);
}

void main().catch((err) => {
	process.stderr.write(`bench:feeds failed: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

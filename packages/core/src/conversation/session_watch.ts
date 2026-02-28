import { join } from "node:path";
import {
	createJsonlStreamReader,
	findLatestSessionId,
	formatConversationEvent,
	formatTurnBenchmarkEvent,
	parseSessionWatchArgs,
	readCurrentSessionId,
	resolveDataRoot,
	type JsonlStreamReader,
	type SessionWatchRenderState,
} from "./stream.js";

interface SessionWatchState {
	sessionId: string;
	reader: JsonlStreamReader;
	renderState: SessionWatchRenderState;
}

export async function runSessionWatchCli(options: {
	argv?: string[];
	commandName?: string;
	deprecationNotice?: string;
} = {}): Promise<void> {
	const parsed = parseSessionWatchArgs(options.argv ?? process.argv.slice(2));
	if (parsed.help) {
		printHelp(options.commandName ?? "pnpm --filter @herzen/core conversation:watch");
		return;
	}

	const dataRoot = resolveDataRoot();
	const conversationsDir = join(dataRoot, "conversations");
	const benchmarkFilePath = join(dataRoot, "logs", "turn_benchmark.jsonl");
	const benchmarkReader = parsed.showBenchmarks
		? createJsonlStreamReader(benchmarkFilePath, { fromNow: parsed.fromNow })
		: null;

	process.stdout.write(
		`Watching conversation stream in ${conversationsDir} (poll ${parsed.pollMs}ms). Press Ctrl+C to stop.\n`,
	);
	if (benchmarkReader) {
		process.stdout.write(`Benchmark stream: ${benchmarkFilePath}\n`);
	}
	if (options.deprecationNotice) {
		process.stderr.write(`${options.deprecationNotice}\n`);
	}

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		process.stdout.write("\nStopping conversation watch.\n");
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	let state: SessionWatchState | null = null;
	let waitingAnnounced = false;

	while (!stopped) {
		try {
			const desiredSessionId =
				parsed.sessionId ??
				(await readCurrentSessionId(conversationsDir)) ??
				(await findLatestSessionId(conversationsDir));

			if (!desiredSessionId) {
				if (!waitingAnnounced) {
					process.stdout.write("Waiting for an active conversation session...\n");
					waitingAnnounced = true;
				}
				await sleep(parsed.pollMs);
				continue;
			}
			waitingAnnounced = false;

			if (!state || state.sessionId !== desiredSessionId) {
				const sessionFilePath = join(conversationsDir, `${desiredSessionId}.jsonl`);
				state = {
					sessionId: desiredSessionId,
					reader: createJsonlStreamReader(sessionFilePath, { fromNow: parsed.fromNow }),
					renderState: {},
				};
				process.stdout.write(`\nAttached to session ${desiredSessionId}${parsed.fromNow ? " (from now)" : ""}\n`);
			}

			const sessionRecords = await state.reader.poll();
			for (const record of sessionRecords) {
				if (!isRecord(record)) continue;
				for (const line of formatConversationEvent(record, state.renderState)) {
					process.stdout.write(`${line}\n`);
				}
			}

			if (benchmarkReader) {
				const benchmarkRecords = await benchmarkReader.poll();
				for (const record of benchmarkRecords) {
					if (!isRecord(record)) continue;
					const eventSessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
					if (eventSessionId !== state.sessionId) continue;
					for (const line of formatTurnBenchmarkEvent(record, state.renderState)) {
						process.stdout.write(`${line}\n`);
					}
				}
			}
		} catch (err) {
			process.stderr.write(`[conversation:watch] ${formatError(err)}\n`);
		}

		await sleep(parsed.pollMs);
	}
}

function printHelp(commandName: string): void {
	process.stdout.write(
		[
			`Usage: ${commandName} [options]`,
			"",
			"Options:",
			"  --session <id>   Watch a specific session only",
			"  --from-now       Start at end of current file (skip existing lines)",
			"  --no-benchmark   Hide per-turn benchmark latency lines",
			"  --poll-ms <n>    Poll interval in ms (default: 700)",
			"  -h, --help       Show this help",
			"",
		].join("\n"),
	);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

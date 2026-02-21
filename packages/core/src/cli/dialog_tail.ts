import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	findLatestSessionId,
	formatDialogEvent,
	parseDialogTailArgs,
	readCurrentSessionId,
	resolveDataRoot,
	type DialogTailRenderState,
} from "../dialog_tail.js";

interface TailState {
	sessionId: string;
	filePath: string;
	consumedChars: number;
	buffer: string;
	renderState: DialogTailRenderState;
}

async function main(): Promise<void> {
	const options = parseDialogTailArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const conversationsDir = join(resolveDataRoot(), "conversations");
	process.stdout.write(
		`Watching dialog logs in ${conversationsDir} (poll ${options.pollMs}ms). Press Ctrl+C to stop.\n`,
	);

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		process.stdout.write("\nStopping dialog tail.\n");
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	let state: TailState | null = null;
	let waitingAnnounced = false;

	while (!stopped) {
		try {
			const desiredSessionId =
				options.sessionId ?? (await readCurrentSessionId(conversationsDir)) ?? (await findLatestSessionId(conversationsDir));

			if (!desiredSessionId) {
				if (!waitingAnnounced) {
					process.stdout.write("Waiting for an active conversation session...\n");
					waitingAnnounced = true;
				}
				await sleep(options.pollMs);
				continue;
			}

			waitingAnnounced = false;

			if (!state || state.sessionId !== desiredSessionId) {
				state = await attachSession(conversationsDir, desiredSessionId, options.fromNow);
			}

			state = await pollSession(state);
		} catch (err) {
			process.stderr.write(`[dialog:tail] ${formatError(err)}\n`);
		}

		await sleep(options.pollMs);
	}
}

function printHelp(): void {
	process.stdout.write(
		[
			"Usage: pnpm --filter @herzen/core dialog:tail [options]",
			"",
			"Options:",
			"  --session <id>   Tail a specific session only",
			"  --from-now       Start at end of current file (skip existing lines)",
			"  --poll-ms <n>    Poll interval in ms (default: 700)",
			"  -h, --help       Show this help",
			"",
		].join("\n"),
	);
}

async function attachSession(
	conversationsDir: string,
	sessionId: string,
	fromNow: boolean,
): Promise<TailState> {
	const filePath = join(conversationsDir, `${sessionId}.jsonl`);
	const initial = await readUtf8IfExists(filePath);
	const consumedChars = fromNow && initial ? initial.length : 0;
	process.stdout.write(`\nAttached to session ${sessionId}${fromNow ? " (from now)" : ""}\n`);
	return {
		sessionId,
		filePath,
		consumedChars,
		buffer: "",
		renderState: {},
	};
}

async function pollSession(state: TailState): Promise<TailState> {
	const content = await readUtf8IfExists(state.filePath);
	if (content === null) return state;

	let consumedChars = state.consumedChars;
	let buffer = state.buffer;

	if (content.length < consumedChars) {
		consumedChars = 0;
		buffer = "";
	}

	const delta = content.slice(consumedChars);
	if (!delta) {
		return {
			...state,
			consumedChars: content.length,
			buffer,
		};
	}

	consumedChars = content.length;
	const combined = `${buffer}${delta}`;
	const segments = combined.split("\n");
	buffer = segments.pop() ?? "";

	for (const rawLine of segments) {
		const line = rawLine.trim();
		if (!line) continue;

		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			for (const outputLine of formatDialogEvent(event, state.renderState)) {
				process.stdout.write(`${outputLine}\n`);
			}
		} catch (err) {
			process.stderr.write(`[dialog:tail] Failed to parse event line: ${formatError(err)}\n`);
		}
	}

	return {
		...state,
		consumedChars,
		buffer,
	};
}

async function readUtf8IfExists(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
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

void main().catch((err) => {
	process.stderr.write(`[dialog:tail] Fatal: ${formatError(err)}\n`);
	process.exit(1);
});

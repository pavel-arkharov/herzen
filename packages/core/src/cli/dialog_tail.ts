import { runSessionWatchCli } from "../conversation/session_watch.js";

void runSessionWatchCli({
	commandName: "pnpm --filter @herzen/core dialog:tail",
	deprecationNotice:
		"[deprecated] `dialog:tail` will be removed in a future release. Use `conversation:watch` instead.",
}).catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[dialog:tail] Fatal: ${message}\n`);
	process.exit(1);
});

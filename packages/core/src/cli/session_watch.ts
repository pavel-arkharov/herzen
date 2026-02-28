import { runSessionWatchCli } from "../conversation/session_watch.js";

void runSessionWatchCli({
	commandName: "pnpm --filter @herzen/core conversation:watch",
}).catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[conversation:watch] Fatal: ${message}\n`);
	process.exit(1);
});

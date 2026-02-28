import { join } from "node:path";
import { resolveDataRoot } from "../app/paths.js";
import { pruneLogDirectory, resolveLogRetentionPolicy } from "../observability/log_retention.js";

function printHelp(): void {
	process.stdout.write(
		[
			"Usage: pnpm --filter @herzen/core logs:prune",
			"",
			"Prunes JSONL log files in data/logs using retention settings from the settings registry.",
			"",
		].join("\n"),
	);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		return;
	}

	const policy = resolveLogRetentionPolicy(process.env);
	if (!policy.enabled) {
		process.stdout.write("Log retention is disabled (HERZEN_LOG_RETENTION_ENABLED=0).\n");
		return;
	}

	const logsDir = join(resolveDataRoot(), "logs");
	const result = await pruneLogDirectory(logsDir, {
		enabled: policy.enabled,
		maxBytes: policy.maxBytes,
		maxAgeDays: policy.maxAgeDays,
	});
	process.stdout.write(
		`Pruned logs in ${logsDir}: scanned=${result.scannedFiles} removed=${result.removedFiles.length} before=${result.totalBytesBefore}B after=${result.totalBytesAfter}B\n`,
	);
}

void main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[logs:prune] ${message}\n`);
	process.exit(1);
});

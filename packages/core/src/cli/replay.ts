import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHomeAssistantConfig } from "@herzen/integration-homeassistant";
import { createDeterministicIntentRouter } from "../intent/router.js";
import { resolveSettings } from "../settings/registry.js";
import {
	formatReplayReport,
	loadReplaySessionInput,
	replayDeterministicSession,
} from "../replay/harness.js";

const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "data");

interface CliOptions {
	sessionId: string;
	dataRoot: string;
	jsonOut?: string;
	recordedModel: boolean;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (!options.sessionId) {
		throw new Error("Missing required --session <session-id> argument.");
	}

	const conversationsFile = join(options.dataRoot, "conversations", `${options.sessionId}.jsonl`);
	const controlSessionFile =
		options.recordedModel ? join(options.dataRoot, "control", "sessions", `${options.sessionId}.jsonl`) : undefined;
	const input = loadReplaySessionInput({
		sessionId: options.sessionId,
		conversationsFile,
		controlSessionFile,
	});
	if (input.turns.length === 0) {
		throw new Error(`No replayable user turns found for session ${options.sessionId}.`);
	}

	const router = createDeterministicIntentRouter({
		homeAssistantConfig: resolveHomeAssistantRouterConfig(process.env),
	});
	const report = replayDeterministicSession({
		sessionId: options.sessionId,
		router,
		turns: input.turns,
		recordedModelRoutes: options.recordedModel ? input.recordedModelRoutes : undefined,
	});

	const humanReport = formatReplayReport(report);
	process.stdout.write(humanReport);

	const jsonOutPath =
		options.jsonOut ??
		join(options.dataRoot, "control", "replay", `${options.sessionId}-${Date.now()}.report.json`);
	mkdirSync(dirname(jsonOutPath), { recursive: true });
	await writeFile(jsonOutPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	process.stdout.write(`JSON report: ${jsonOutPath}\n`);
}

function parseArgs(args: string[]): CliOptions {
	let sessionId = "";
	let dataRoot = defaultDataRoot;
	let jsonOut: string | undefined;
	let recordedModel = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--session") {
			sessionId = args[index + 1] ?? "";
			index += 1;
			continue;
		}
		if (arg === "--data-dir") {
			const value = args[index + 1] ?? "";
			if (value) dataRoot = resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--json-out") {
			const value = args[index + 1] ?? "";
			if (value) jsonOut = resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--recorded-model") {
			recordedModel = true;
			continue;
		}
	}

	return {
		sessionId,
		dataRoot,
		jsonOut,
		recordedModel,
	};
}

function resolveHomeAssistantRouterConfig(env: NodeJS.ProcessEnv) {
	try {
		const settings = resolveSettings(env).ha;
		return resolveHomeAssistantConfig(env, {
			enabled: settings.enabled,
			timeoutMs: settings.timeoutMs,
		});
	} catch {
		return null;
	}
}

void main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { resolveDataRoot } from "../app/paths.js";
import {
	resolveInitialAdaptiveMaxSecondsInteractive,
	resolveInitialRecordingModeInteractive,
	type RecordingMode,
} from "../recording/factory.js";
import {
	loadRuntimeEnvOverrides,
	saveRuntimeEnvOverrides,
} from "../settings/runtime_overrides.js";
import {
	resolveInitialTriggerModeInteractive,
} from "../trigger/factory.js";
import type { TriggerMode } from "../trigger/types.js";

type RuntimeProfile = "voice" | "text" | "hybrid";

function resolveRuntimeProfile(rawValue: string | undefined): RuntimeProfile {
	const normalized = rawValue?.trim().toLowerCase();
	if (normalized === "text") return "text";
	if (normalized === "hybrid") return "hybrid";
	return "voice";
}

async function promptRuntimeProfile(defaultProfile: RuntimeProfile): Promise<RuntimeProfile> {
	if (!process.stdin.isTTY) return defaultProfile;
	const defaultChoice = defaultProfile === "voice" ? "1" : defaultProfile === "text" ? "2" : "3";
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(
			`Choose runtime profile: [1] Voice, [2] Text, [3] Hybrid (default ${defaultChoice}) `,
			(answer) => {
				rl.close();
				const normalized = answer.trim().toLowerCase() || defaultChoice;
				if (normalized === "2" || normalized === "text") {
					resolve("text");
					return;
				}
				if (normalized === "3" || normalized === "hybrid") {
					resolve("hybrid");
					return;
				}
				resolve("voice");
			},
		);
	});
}

async function main(): Promise<void> {
	if (!process.stdin.isTTY) {
		throw new Error("setup:interactive requires a TTY terminal.");
	}

	const dataRoot = resolveDataRoot();
	const controlDir = join(dataRoot, "control");
	const existingOverrides = loadRuntimeEnvOverrides(controlDir);
	const env = {
		...process.env,
		...existingOverrides,
	};

	const recordingMode: RecordingMode = await resolveInitialRecordingModeInteractive({
		rawMode: env.HERZEN_RECORD_MODE,
		isInteractive: true,
	});
	const triggerMode: TriggerMode = await resolveInitialTriggerModeInteractive({
		rawMode: env.HERZEN_TRIGGER_MODE,
		isInteractive: true,
	});
	const runtimeProfile = await promptRuntimeProfile(resolveRuntimeProfile(env.HERZEN_RUNTIME_PROFILE));

	const nextOverrides: Record<string, string> = {
		...existingOverrides,
		HERZEN_RECORD_MODE: recordingMode,
		HERZEN_TRIGGER_MODE: triggerMode,
		HERZEN_RUNTIME_PROFILE: runtimeProfile,
	};
	if (recordingMode === "adaptive") {
		const adaptiveMaxSeconds = await resolveInitialAdaptiveMaxSecondsInteractive({
			rawMaxSeconds: env.HERZEN_RECORD_MAX_SECONDS,
			defaultMaxSeconds: 60,
			isInteractive: true,
		});
		nextOverrides.HERZEN_RECORD_MAX_SECONDS = String(adaptiveMaxSeconds);
	}

	await saveRuntimeEnvOverrides(controlDir, nextOverrides);
	process.stdout.write("Saved interactive runtime setup.\n");
	process.stdout.write(
		[
			`data=${dataRoot}`,
			`profile=${runtimeProfile}`,
			`trigger=${triggerMode}`,
			`recording=${recordingMode}`,
			`adaptive_max=${nextOverrides.HERZEN_RECORD_MAX_SECONDS ?? "-"}`,
		].join("\n") + "\n",
	);
}

void main().catch((err) => {
	process.stderr.write(`setup:interactive failed: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

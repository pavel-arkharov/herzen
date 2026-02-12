import { StdinTriggerSource } from "./stdin.js";
import type { TriggerMode, TriggerSource } from "./types.js";
import { WakeWordTriggerSource } from "./wakeword.js";

const SUPPORTED_TRIGGER_MODES: TriggerMode[] = ["stdin", "wakeword"];

export function resolveTriggerMode(rawMode = process.env.HERZEN_TRIGGER_MODE): TriggerMode {
	const normalized = (rawMode ?? "stdin").trim().toLowerCase();
	if (normalized === "stdin" || normalized === "wakeword") {
		return normalized;
	}

	throw new Error(
		`Unsupported trigger mode "${rawMode ?? ""}". Supported modes: ${SUPPORTED_TRIGGER_MODES.join(", ")}.`,
	);
}

export function createTriggerSource(mode: TriggerMode): TriggerSource {
	if (mode === "stdin") return new StdinTriggerSource();
	return new WakeWordTriggerSource();
}

import readline from "node:readline";
import { StdinTriggerSource } from "./stdin.js";
import type { TriggerMode, TriggerSource } from "./types.js";
import { WakeWordTriggerSource } from "./wakeword.js";

const SUPPORTED_TRIGGER_MODES: TriggerMode[] = ["stdin", "wakeword"];
const DEFAULT_PROMPT_TIMEOUT_MS = 10_000;

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

interface PromptRequest {
	message: string;
	defaultValue: string;
	timeoutMs: number;
}

type PromptFn = (request: PromptRequest) => Promise<string>;

export interface InitialTriggerModeOptions {
	rawMode?: string | undefined;
	isInteractive?: boolean;
	promptTimeoutMs?: number;
	prompt?: PromptFn;
}

export interface WakewordFallbackPromptOptions {
	isInteractive?: boolean;
	promptTimeoutMs?: number;
	prompt?: PromptFn;
}

export async function resolveInitialTriggerModeInteractive(
	options: InitialTriggerModeOptions = {},
): Promise<TriggerMode> {
	const rawMode = options.rawMode ?? process.env.HERZEN_TRIGGER_MODE;
	if (rawMode !== undefined) return resolveTriggerMode(rawMode);

	const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY);
	if (!isInteractive) return "stdin";

	const prompt = options.prompt ?? promptWithTimeout;
	const answer = await prompt({
		message: "Choose trigger mode: [1] Wakeword, [2] Enter",
		defaultValue: "2",
		timeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
	});

	return parseInteractiveModeChoice(answer);
}

export async function shouldSwitchToStdinAfterWakewordFailure(
	options: WakewordFallbackPromptOptions = {},
): Promise<boolean> {
	const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY);
	if (!isInteractive) return false;

	const prompt = options.prompt ?? promptWithTimeout;
	const answer = await prompt({
		message: "Wakeword unavailable. Switch to Enter trigger? [Y/n]",
		defaultValue: "y",
		timeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
	});

	const normalized = answer.trim().toLowerCase();
	if (!normalized) return true;
	if (normalized === "y" || normalized === "yes") return true;
	if (normalized === "n" || normalized === "no") return false;
	return true;
}

function parseInteractiveModeChoice(answer: string): TriggerMode {
	const normalized = answer.trim().toLowerCase();
	if (normalized === "1" || normalized === "wakeword") return "wakeword";
	return "stdin";
}

function promptWithTimeout(request: PromptRequest): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		let settled = false;

		const settle = (value: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rl.close();
			resolve(value);
		};

		const timer = setTimeout(() => {
			process.stdout.write("\n");
			settle(request.defaultValue);
		}, request.timeoutMs);

		rl.question(`${request.message} `, (answer) => {
			const normalized = answer.trim();
			settle(normalized || request.defaultValue);
		});
	});
}

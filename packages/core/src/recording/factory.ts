import readline from "node:readline";

export type RecordingMode = "fixed" | "adaptive";

const DEFAULT_PROMPT_TIMEOUT_MS = 10_000;
const DEFAULT_ADAPTIVE_MAX_SECONDS = 30;

interface PromptRequest {
	message: string;
	defaultValue: string;
	timeoutMs: number;
}

type PromptFn = (request: PromptRequest) => Promise<string>;

export interface InitialRecordingModeOptions {
	rawMode?: string | undefined;
	isInteractive?: boolean;
	promptTimeoutMs?: number;
	prompt?: PromptFn;
}

export interface InitialAdaptiveMaxSecondsOptions {
	rawMaxSeconds?: string | undefined;
	isInteractive?: boolean;
	promptTimeoutMs?: number;
	defaultMaxSeconds?: number;
	prompt?: PromptFn;
}

export function resolveRecordingMode(rawMode = process.env.HERZEN_RECORD_MODE): RecordingMode {
	const normalized = (rawMode ?? "fixed").trim().toLowerCase();
	if (normalized === "fixed" || normalized === "adaptive") return normalized;

	throw new Error(
		`Unsupported record mode "${rawMode ?? ""}". Supported modes: fixed, adaptive.`,
	);
}

export async function resolveInitialRecordingModeInteractive(
	options: InitialRecordingModeOptions = {},
): Promise<RecordingMode> {
	const rawMode = options.rawMode ?? process.env.HERZEN_RECORD_MODE;
	const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY);
	const defaultMode = rawMode !== undefined ? resolveRecordingMode(rawMode) : "fixed";
	if (!isInteractive) return defaultMode;

	const prompt = options.prompt ?? promptWithTimeout;
	const answer = await prompt({
		message: "Choose recording mode: [1] Adaptive, [2] Fixed",
		defaultValue: defaultMode === "adaptive" ? "1" : "2",
		timeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
	});

	return parseRecordingModeChoice(answer);
}

export async function resolveInitialAdaptiveMaxSecondsInteractive(
	options: InitialAdaptiveMaxSecondsOptions = {},
): Promise<number> {
	const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY);
	const defaultMaxSeconds = resolveDefaultAdaptiveMaxSeconds(options.defaultMaxSeconds);

	if (!isInteractive) {
		return parsePositiveSecondsOrFallback(options.rawMaxSeconds, defaultMaxSeconds);
	}

	const prompt = options.prompt ?? promptWithTimeout;
	const answer = await prompt({
		message: `Set adaptive max length in seconds (default ${defaultMaxSeconds})`,
		defaultValue: String(defaultMaxSeconds),
		timeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
	});

	return parsePositiveSecondsOrFallback(answer, defaultMaxSeconds);
}

function parseRecordingModeChoice(answer: string): RecordingMode {
	const normalized = answer.trim().toLowerCase();
	if (normalized === "1" || normalized === "adaptive") return "adaptive";
	return "fixed";
}

function resolveDefaultAdaptiveMaxSeconds(rawDefault: number | undefined): number {
	if (rawDefault === undefined) return DEFAULT_ADAPTIVE_MAX_SECONDS;
	if (!Number.isFinite(rawDefault) || rawDefault <= 0) return DEFAULT_ADAPTIVE_MAX_SECONDS;
	return rawDefault;
}

function parsePositiveSecondsOrFallback(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
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

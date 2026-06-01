#!/usr/bin/env node
import { basename, extname, join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { runListenCli } from "./listen_cli.js";
import { type TranscribeDocumentFormat } from "./document.js";
import { type SttLanguage } from "./transcribe.js";

const DEFAULT_CHUNK_SECONDS = 60;
const USAGE = `Usage: herzen transcribe [--duration <value> | --until-stopped] [--chunk <seconds>] [--output <filename-or-path>] [--lang auto|en|ru]

Examples:
  herzen transcribe
  herzen transcribe --duration 53m --chunk 300 --output secure-player-live.txt --lang auto
  herzen transcribe --until-stopped --chunk 60 --output live-session.txt --lang auto`;

interface HerzenCliDeps {
	runListen: (argv: string[]) => Promise<number>;
	stdout: { log: (...args: unknown[]) => void };
	stderr: { error: (...args: unknown[]) => void };
	isTty: boolean;
	prompt: (question: string) => Promise<string>;
	now: () => Date;
}

interface ParsedHerzenArgs {
	subcommand: "transcribe";
	durationInput?: string;
	untilStopped: boolean;
	chunkSeconds?: number;
	output?: string;
	language: SttLanguage;
}

class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

class CliHelpError extends Error {
	constructor() {
		super(USAGE);
		this.name = "CliHelpError";
	}
}

export async function runHerzenCli(
	argv: string[] = process.argv.slice(2),
	deps: HerzenCliDeps = {
		runListen: runListenCli,
		stdout: console,
		stderr: console,
		isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		prompt: promptLine,
		now: () => new Date(),
	},
): Promise<number> {
	let parsed: ParsedHerzenArgs;
	try {
		parsed = parseHerzenCliArgs(argv);
	} catch (err) {
		if (err instanceof CliHelpError) {
			deps.stdout.log(USAGE);
			return 0;
		}
		if (err instanceof CliUsageError) {
			deps.stderr.error(`${err.message}\n${USAGE}`);
			return 1;
		}
		throw err;
	}

	if (parsed.subcommand !== "transcribe") {
		deps.stderr.error(USAGE);
		return 1;
	}

	try {
		const resolved = await resolveTranscribeInvocation(parsed, deps);
		return await deps.runListen(resolved.listenArgv);
	} catch (err) {
		if (err instanceof CliUsageError) {
			deps.stderr.error(`${err.message}\n${USAGE}`);
			return 1;
		}
		const message = err instanceof Error ? err.message : String(err);
		deps.stderr.error(`herzen transcribe failed: ${message}`);
		return 1;
	}
}

export function parseHerzenCliArgs(argv: string[]): ParsedHerzenArgs {
	const filtered = argv.filter((token) => token !== "--");
	const [subcommand, ...rest] = filtered;
	if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
		throw new CliHelpError();
	}
	if (subcommand !== "transcribe") {
		throw new CliUsageError(`Unknown subcommand: ${subcommand}`);
	}

	const map = new Map<string, string>();
	let untilStopped = false;
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith("--")) {
			throw new CliUsageError(`Unexpected positional argument: ${token}`);
		}
		const key = token.slice(2);
		if (!["duration", "until-stopped", "chunk", "output", "lang"].includes(key)) {
			throw new CliUsageError(`Unknown argument: ${token}`);
		}
		if (key === "until-stopped") {
			untilStopped = true;
			continue;
		}
		const value = rest[index + 1];
		if (!value || value.startsWith("--")) {
			throw new CliUsageError(`Missing value for ${token}`);
		}
		map.set(key, value);
		index += 1;
	}

	const durationInput = map.get("duration");
	if (untilStopped && durationInput) {
		throw new CliUsageError("Provide either --duration <value> or --until-stopped, not both.");
	}

	const chunkRaw = map.get("chunk");
	const chunkSeconds = chunkRaw === undefined ? undefined : parsePositiveNumber(chunkRaw, "--chunk");
	const languageRaw = map.get("lang") ?? "auto";
	if (!isLanguage(languageRaw)) {
		throw new CliUsageError(`Invalid --lang value "${languageRaw}". Expected auto, en, or ru.`);
	}

	return {
		subcommand: "transcribe",
		durationInput,
		untilStopped,
		chunkSeconds,
		output: map.get("output"),
		language: languageRaw,
	};
}

async function resolveTranscribeInvocation(
	parsed: ParsedHerzenArgs,
	deps: HerzenCliDeps,
): Promise<{
	listenArgv: string[];
}> {
	const captureMode =
		parsed.untilStopped ? { untilStopped: true as const }
		: parsed.durationInput ? parseCaptureMode(parsed.durationInput)
		: deps.isTty ? await promptForCaptureMode(deps)
		: (() => {
				throw new CliUsageError(
					"Missing capture mode. Run `herzen transcribe --duration 53m` or use an interactive TTY.",
				);
			})();

	const chunkSeconds =
		parsed.chunkSeconds ?? (deps.isTty ? await promptForChunkSeconds(deps) : DEFAULT_CHUNK_SECONDS);
	const outputSpec =
		parsed.output ? normalizeOutputSpec(parsed.output, deps.now())
		: deps.isTty ? await promptForOutputSpec(deps)
		: normalizeOutputSpec(defaultOutputFileName(deps.now()), deps.now());

	const listenArgv = captureMode.untilStopped ? ["--until-stopped"] : ["--duration-seconds", String(captureMode.durationSeconds)];
	listenArgv.push("--chunk-seconds", String(chunkSeconds));
	listenArgv.push("--lang", parsed.language);
	listenArgv.push("--format", outputSpec.format);
	listenArgv.push("--out", outputSpec.outputPath);
	listenArgv.push("--name", outputSpec.outputName);
	return { listenArgv };
}

async function promptForCaptureMode(deps: HerzenCliDeps): Promise<
	| { untilStopped: true }
	| { untilStopped: false; durationSeconds: number }
> {
	while (true) {
		const answer = (
			await deps.prompt(
				"Duration [until-stopped] (examples: 2m, 53m, 120s, 02:00): ",
			)
		).trim();
		try {
			return parseCaptureMode(answer || "until-stopped");
		} catch (err) {
			deps.stderr.error(err instanceof Error ? err.message : String(err));
		}
	}
}

async function promptForChunkSeconds(deps: HerzenCliDeps): Promise<number> {
	while (true) {
		const answer = (await deps.prompt(`Chunk seconds [${DEFAULT_CHUNK_SECONDS}]: `)).trim();
		try {
			return answer ? parsePositiveNumber(answer, "chunk seconds") : DEFAULT_CHUNK_SECONDS;
		} catch (err) {
			deps.stderr.error(err instanceof Error ? err.message : String(err));
		}
	}
}

async function promptForOutputSpec(deps: HerzenCliDeps): Promise<NormalizedOutputSpec> {
	const fallback = defaultOutputFileName(deps.now());
	while (true) {
		const answer = (await deps.prompt(`Output filename [${fallback}]: `)).trim();
		try {
			return normalizeOutputSpec(answer || fallback, deps.now());
		} catch (err) {
			deps.stderr.error(err instanceof Error ? err.message : String(err));
		}
	}
}

type NormalizedOutputSpec = {
	outputPath: string;
	outputName: string;
	format: TranscribeDocumentFormat;
};

function normalizeOutputSpec(rawOutput: string, now: Date): NormalizedOutputSpec {
	const trimmed = rawOutput.trim();
	if (!trimmed) {
		throw new CliUsageError("Output filename cannot be empty.");
	}
	const withExtension =
		extname(trimmed) === "" ? `${trimmed}.txt`
		: trimmed;
	const format = inferOutputFormat(withExtension);
	const outputPath =
		withExtension.includes("/") ? withExtension : join("data", "transcribes", withExtension);
	const stem = basename(withExtension, extname(withExtension)).trim();
	const outputName = stem || basename(defaultOutputFileName(now), ".txt");
	return {
		outputPath,
		outputName,
		format,
	};
}

function inferOutputFormat(filePath: string): TranscribeDocumentFormat {
	const extension = extname(filePath).toLowerCase();
	if (extension === ".txt") return "txt";
	if (extension === ".md") return "md";
	throw new CliUsageError(
		`Unsupported output extension "${extension || "(none)"}". Use .txt or .md.`,
	);
}

function parseCaptureMode(input: string):
	| { untilStopped: true }
	| { untilStopped: false; durationSeconds: number } {
	const normalized = input.trim().toLowerCase();
	if (["until-stopped", "until", "live", "stop"].includes(normalized)) {
		return { untilStopped: true };
	}
	return {
		untilStopped: false,
		durationSeconds: parseDurationSeconds(input),
	};
}

function parseDurationSeconds(rawValue: string): number {
	const trimmed = rawValue.trim().toLowerCase();
	if (!trimmed) {
		throw new CliUsageError("Duration is required.");
	}

	if (trimmed.includes(":")) {
		const parts = trimmed.split(":");
		if (parts.some((part) => part.trim() === "" || !/^\d+(?:\.\d+)?$/.test(part))) {
			throw new CliUsageError(`Invalid duration value "${rawValue}".`);
		}
		if (parts.length === 2) {
			const [minutes, seconds] = parts.map(Number);
			return validateDurationSeconds(minutes * 60 + seconds, rawValue);
		}
		if (parts.length === 3) {
			const [hours, minutes, seconds] = parts.map(Number);
			return validateDurationSeconds(hours * 3600 + minutes * 60 + seconds, rawValue);
		}
		throw new CliUsageError(`Invalid duration value "${rawValue}".`);
	}

	const match = trimmed.match(/^(\d+(?:\.\d+)?)([a-z]+)?$/);
	if (!match) {
		throw new CliUsageError(`Invalid duration value "${rawValue}".`);
	}
	const amount = Number(match[1]);
	const unit = match[2] ?? "s";
	const multiplier = resolveDurationUnitMultiplier(unit, rawValue);
	return validateDurationSeconds(amount * multiplier, rawValue);
}

function resolveDurationUnitMultiplier(unit: string, rawValue: string): number {
	if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return 1;
	if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return 60;
	if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return 3600;
	throw new CliUsageError(`Invalid duration unit in "${rawValue}". Use s, m, or h.`);
}

function validateDurationSeconds(value: number, rawValue: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new CliUsageError(`Invalid duration value "${rawValue}". Expected a positive duration.`);
	}
	return value;
}

function parsePositiveNumber(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new CliUsageError(`Invalid ${label} value "${value}". Expected a positive number.`);
	}
	return parsed;
}

function defaultOutputFileName(now: Date): string {
	return `transcript-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.txt`;
}

function isLanguage(value: string): value is SttLanguage {
	return value === "auto" || value === "en" || value === "ru";
}

function promptLine(question: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

if (isMain()) {
	void runHerzenCli().then((code) => {
		process.exit(code);
	});
}

function isMain(): boolean {
	const entrypoint = process.argv[1];
	if (!entrypoint) return false;
	return import.meta.url === pathToFileURL(entrypoint).href;
}

#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	transcribeMicrophoneToDocument,
	type TranscribeMicrophoneToDocumentOptions,
} from "./listen.js";
import { type TranscribeDocumentFormat } from "./document.js";
import { type SttLanguage, SttError } from "./transcribe.js";

const USAGE = `Usage: herzen-stt-listen --duration-minutes <minutes> [--chunk-seconds <seconds>] [--lang auto|en|ru] [--format txt|md] [--out <path>] [--name <base-name>] [--audio-out <path>] [--audio-dir <path>]
       herzen-stt-listen --duration-seconds <seconds> [--chunk-seconds <seconds>] [--lang auto|en|ru] [--format txt|md] [--out <path>] [--name <base-name>] [--audio-out <path>] [--audio-dir <path>]
       herzen-stt-listen --until-stopped [--chunk-seconds <seconds>] [--lang auto|en|ru] [--format txt|md] [--out <path>] [--name <base-name>] [--audio-out <path>] [--audio-dir <path>]`;

interface ListenCliDeps {
	transcribe: (
		options: TranscribeMicrophoneToDocumentOptions,
	) => Promise<{ outputPath: string; audioPath: string }>;
	stdout: { log: (...args: unknown[]) => void };
	stderr: { error: (...args: unknown[]) => void };
}

interface ParsedListenArgs {
	durationSeconds?: number;
	untilStopped: boolean;
	chunkSeconds?: number;
	language: SttLanguage;
	format: TranscribeDocumentFormat;
	outputPath?: string;
	outputName?: string;
	audioPath?: string;
	audioDir?: string;
}

class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export async function runListenCli(
	argv: string[] = process.argv.slice(2),
	deps: ListenCliDeps = {
		transcribe: transcribeMicrophoneToDocument,
		stdout: console,
		stderr: console,
	},
): Promise<number> {
	let parsed: ParsedListenArgs;
	try {
		parsed = parseListenCliArgs(argv);
	} catch (err) {
		if (err instanceof CliUsageError) {
			deps.stderr.error(`${err.message}\n${USAGE}`);
			return 1;
		}
		throw err;
	}

	try {
		if (parsed.untilStopped) {
			deps.stdout.log(
				`Recording microphone until stopped in ${parsed.chunkSeconds ?? 30}s chunks. Press Ctrl+C once to stop recording and finalize transcription...`,
			);
		} else if (parsed.chunkSeconds !== undefined) {
			deps.stdout.log(
				`Recording microphone for ${parsed.durationSeconds?.toFixed(1)}s with ${parsed.chunkSeconds.toFixed(1)}s live chunks...`,
			);
		} else {
			deps.stdout.log(
				`Recording microphone for ${parsed.durationSeconds?.toFixed(1)}s before transcription starts...`,
			);
		}
		const result = await deps.transcribe({
			durationSeconds: parsed.durationSeconds,
			untilStopped: parsed.untilStopped,
			chunkSeconds: parsed.chunkSeconds,
			language: parsed.language,
			format: parsed.format,
			outputPath: parsed.outputPath,
			outputName: parsed.outputName,
			audioPath: parsed.audioPath,
			audioDir: parsed.audioDir,
			workingDir: resolveInvocationDir(),
		});
		deps.stdout.log(`Recording saved: ${result.audioPath}`);
		deps.stdout.log(`Transcription saved: ${result.outputPath}`);
		return 0;
	} catch (err) {
		if (err instanceof SttError) {
			deps.stderr.error(err.message);
			return 1;
		}
		const message = err instanceof Error ? err.message : String(err);
		deps.stderr.error(`Transcription failed: ${message}`);
		return 1;
	}
}

export function parseListenCliArgs(argv: string[]): ParsedListenArgs {
	const map = new Map<string, string>();
	let untilStopped = false;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--") continue;
		if (token === "--help" || token === "-h") throw new CliUsageError(USAGE);
		if (!token.startsWith("--")) {
			throw new CliUsageError(`Unexpected positional argument: ${token}`);
		}
		const key = token.slice(2);
		if (
				![
						"duration-minutes",
						"duration-seconds",
						"until-stopped",
						"chunk-seconds",
						"lang",
						"format",
						"out",
				"name",
				"audio-out",
				"audio-dir",
			].includes(key)
		) {
			throw new CliUsageError(`Unknown argument: ${token}`);
		}
		if (key === "until-stopped") {
			untilStopped = true;
			continue;
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new CliUsageError(`Missing value for ${token}`);
		}
		map.set(key, value);
		index += 1;
	}

	const durationMinutes = map.get("duration-minutes");
	const durationSeconds = map.get("duration-seconds");
	if (untilStopped && (durationMinutes || durationSeconds)) {
		throw new CliUsageError(
			"Provide microphone capture either as a duration or with --until-stopped, not both.",
		);
	}
	if (durationMinutes && durationSeconds) {
		throw new CliUsageError(
			"Provide duration either via --duration-minutes or --duration-seconds, not both.",
		);
	}
	if (!untilStopped && !durationMinutes && !durationSeconds) {
		throw new CliUsageError(
			"Missing required capture mode: --duration-minutes <minutes>, --duration-seconds <seconds>, or --until-stopped",
		);
	}

	const languageRaw = map.get("lang") ?? "en";
	if (!isLanguage(languageRaw)) {
		throw new CliUsageError(`Invalid --lang value "${languageRaw}". Expected auto, en, or ru.`);
	}

	const formatRaw = map.get("format") ?? "txt";
	if (!isFormat(formatRaw)) {
		throw new CliUsageError(`Invalid --format value "${formatRaw}". Expected txt or md.`);
	}

	const parsed: ParsedListenArgs = {
		durationSeconds:
			untilStopped ? undefined
			: durationMinutes !== undefined ?
				parsePositiveNumber(durationMinutes, "--duration-minutes") * 60
			:	parsePositiveNumber(durationSeconds ?? "", "--duration-seconds"),
		untilStopped,
		chunkSeconds: parseOptionalPositiveNumber(map.get("chunk-seconds"), "--chunk-seconds"),
		language: languageRaw,
		format: formatRaw,
	};

	const outputPath = map.get("out");
	if (outputPath) parsed.outputPath = outputPath;
	const outputName = map.get("name");
	if (outputName) parsed.outputName = outputName;
	const audioPath = map.get("audio-out");
	if (audioPath) parsed.audioPath = audioPath;
	const audioDir = map.get("audio-dir");
	if (audioDir) parsed.audioDir = audioDir;

	return parsed;
}

function parsePositiveNumber(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new CliUsageError(`Invalid ${flag} value "${value}". Expected a positive number.`);
	}
	return parsed;
}

function parseOptionalPositiveNumber(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	return parsePositiveNumber(value, flag);
}

function isLanguage(value: string): value is SttLanguage {
	return value === "auto" || value === "en" || value === "ru";
}

function isFormat(value: string): value is TranscribeDocumentFormat {
	return value === "txt" || value === "md";
}

function resolveInvocationDir(): string {
	const initCwd = process.env.INIT_CWD?.trim();
	if (initCwd) return resolve(initCwd);
	return process.cwd();
}

if (isMain()) {
	void runListenCli().then((code) => {
		process.exit(code);
	});
}

function isMain(): boolean {
	const entrypoint = process.argv[1];
	if (!entrypoint) return false;
	return import.meta.url === pathToFileURL(entrypoint).href;
}

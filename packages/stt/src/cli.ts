#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type TranscribeDocumentFormat,
	type TranscribeFileToDocumentOptions,
	transcribeFileToDocument,
} from "./document.js";
import { type SttLanguage, SttError } from "./transcribe.js";

const USAGE = `Usage: herzen-stt <file> [--lang auto|en|ru] [--format txt|md] [--out <path>] [--name <base-name>]
       herzen-stt --input <file> [--lang auto|en|ru] [--format txt|md] [--out <path>] [--name <base-name>]`;

interface CliDeps {
	transcribe: (options: TranscribeFileToDocumentOptions) => Promise<{ outputPath: string }>;
	stdout: { log: (...args: unknown[]) => void };
	stderr: { error: (...args: unknown[]) => void };
}

interface ParsedArgs {
	inputPath: string;
	language: SttLanguage;
	format: TranscribeDocumentFormat;
	outputPath?: string;
	outputName?: string;
}

class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export async function runCli(
	argv: string[] = process.argv.slice(2),
	deps: CliDeps = {
		transcribe: transcribeFileToDocument,
		stdout: console,
		stderr: console,
	},
): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseCliArgs(argv);
	} catch (err) {
		if (err instanceof CliUsageError) {
			deps.stderr.error(`${err.message}\n${USAGE}`);
			return 1;
		}
		throw err;
	}

	try {
		const result = await deps.transcribe({
			inputPath: parsed.inputPath,
			language: parsed.language,
			format: parsed.format,
			outputPath: parsed.outputPath,
			outputName: parsed.outputName,
			workingDir: resolveInvocationDir(),
		});
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

export function parseCliArgs(argv: string[]): ParsedArgs {
	const map = new Map<string, string>();
	const positionalArgs: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--help" || token === "-h") throw new CliUsageError(USAGE);
		if (!token.startsWith("--")) {
			positionalArgs.push(token);
			continue;
		}
		const key = token.slice(2);
		if (!["input", "lang", "format", "out", "name"].includes(key)) {
			throw new CliUsageError(`Unknown argument: ${token}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new CliUsageError(`Missing value for ${token}`);
		}
		map.set(key, value);
		index += 1;
	}

	if (positionalArgs.length > 1) {
		throw new CliUsageError(
			`Unexpected positional arguments: ${positionalArgs.slice(1).map((value) => `"${value}"`).join(", ")}`,
		);
	}
	if (positionalArgs.length > 0 && map.has("input")) {
		throw new CliUsageError("Provide input either as positional <file> or via --input, not both.");
	}

	const inputPath = map.get("input") ?? positionalArgs[0];
	if (!inputPath) throw new CliUsageError("Missing required argument: <file> or --input");

	const languageRaw = map.get("lang") ?? "auto";
	if (!isLanguage(languageRaw)) {
		throw new CliUsageError(`Invalid --lang value "${languageRaw}". Expected auto, en, or ru.`);
	}

	const formatRaw = map.get("format") ?? "md";
	if (!isFormat(formatRaw)) {
		throw new CliUsageError(`Invalid --format value "${formatRaw}". Expected txt or md.`);
	}

	const parsed: ParsedArgs = {
		inputPath,
		language: languageRaw,
		format: formatRaw,
	};

	const outputPath = map.get("out");
	if (outputPath) parsed.outputPath = outputPath;
	const outputName = map.get("name");
	if (outputName) parsed.outputName = outputName;

	return parsed;
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
	void runCli().then((code) => {
		process.exit(code);
	});
}

function isMain(): boolean {
	const entrypoint = process.argv[1];
	if (!entrypoint) return false;
	return import.meta.url === pathToFileURL(entrypoint).href;
}

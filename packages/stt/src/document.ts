import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { SttError, type SttLanguage, transcribeWav } from "./transcribe.js";

export type TranscribeDocumentFormat = "txt" | "md";

export interface TranscribeFileToDocumentOptions {
	inputPath: string;
	language?: SttLanguage;
	format?: TranscribeDocumentFormat;
	outputPath?: string;
	outputDir?: string;
	outputName?: string;
	workingDir?: string;
}

export interface TranscribeDocumentResult {
	outputPath: string;
	text: string;
	language: string;
	durationMs: number;
	format: TranscribeDocumentFormat;
}

export async function transcribeFileToDocument(
	options: TranscribeFileToDocumentOptions,
): Promise<TranscribeDocumentResult> {
	const workingDir = resolve(options.workingDir ?? process.cwd());
	const language = resolveLanguage(options.language);
	const format = resolveFormat(options.format);
	const resolvedInputPath = resolve(workingDir, options.inputPath);

	await ensureInputExists(resolvedInputPath);

	const transcribed = await transcribeWav(resolvedInputPath, { language });
	const generatedAt = new Date();
	const outputPath = resolveOutputPath({
		workingDir,
		inputPath: resolvedInputPath,
		outputDir: options.outputDir,
		outputName: options.outputName,
		outputPath: options.outputPath,
		format,
		generatedAt,
	});
	const documentContent = renderDocument({
		format,
		text: transcribed.text,
		sourcePath: resolvedInputPath,
		requestedLanguage: language,
		detectedLanguage: transcribed.language,
		generatedAt,
	});

	try {
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, documentContent, "utf8");
	} catch (err) {
		const details = err instanceof Error ? err.message : String(err);
		throw new SttError("TRANSCRIBE_FAILED", `Failed to write transcript file: ${details}`, {
			cause: err,
		});
	}

	return {
		outputPath,
		text: transcribed.text,
		language: transcribed.language,
		durationMs: transcribed.durationMs,
		format,
	};
}

function resolveLanguage(language: SttLanguage | undefined): SttLanguage {
	return language ?? "auto";
}

function resolveFormat(format: TranscribeDocumentFormat | undefined): TranscribeDocumentFormat {
	return format ?? "md";
}

async function ensureInputExists(inputPath: string): Promise<void> {
	try {
		await access(inputPath, constants.F_OK);
	} catch (err) {
		throw new SttError("TRANSCRIBE_FAILED", `Input file not found: ${inputPath}`, { cause: err });
	}
}

function resolveOutputPath(params: {
	workingDir: string;
	inputPath: string;
	outputDir: string | undefined;
	outputName: string | undefined;
	outputPath: string | undefined;
	format: TranscribeDocumentFormat;
	generatedAt: Date;
}): string {
	if (params.outputPath) return resolve(params.workingDir, params.outputPath);

	const baseDir = params.outputDir
		? resolve(params.workingDir, params.outputDir)
		: join(params.workingDir, "data", "transcribes");
	const stem = sanitizeBaseName(params.outputName ?? basename(params.inputPath, extname(params.inputPath)));
	const timestamp = fileTimestamp(params.generatedAt);
	return join(baseDir, `${stem}-${timestamp}.${params.format}`);
}

function sanitizeBaseName(name: string): string {
	const sanitized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "transcript";
}

function fileTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function renderDocument(params: {
	format: TranscribeDocumentFormat;
	text: string;
	sourcePath: string;
	requestedLanguage: SttLanguage;
	detectedLanguage: string;
	generatedAt: Date;
}): string {
	if (params.format === "txt") return `${params.text}\n`;

	return [
		"# Transcript",
		"",
		`- Source file path: \`${params.sourcePath}\``,
		`- Language mode requested: \`${params.requestedLanguage}\``,
		`- Detected language: \`${params.detectedLanguage}\``,
		`- Generated timestamp: \`${params.generatedAt.toISOString()}\``,
		"",
		"## Transcript",
		"",
		params.text,
		"",
	].join("\n");
}

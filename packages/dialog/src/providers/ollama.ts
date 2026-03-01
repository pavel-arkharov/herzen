import { resolveOllamaConfig } from "../config.js";
import {
	type ConversationContextItem,
	ResponseError,
	type ResponseLanguage,
	type ResponseInput,
	type ResponseOutput,
	type ResponseService,
} from "../types.js";

export interface CreateOllamaResponseServiceOptions {
	env?: NodeJS.ProcessEnv;
}

export function createOllamaResponseService(
	options: CreateOllamaResponseServiceOptions = {},
): ResponseService {
	const config = resolveOllamaConfig(options.env ?? process.env);

	return {
		async generateReply(input: ResponseInput): Promise<ResponseOutput> {
			const transcript = input.transcript.trim();
			if (!transcript) {
				throw new ResponseError("OUTPUT_INVALID", "Cannot generate response for empty transcript.");
			}

			const language = resolveResponseLanguage(input.requestedLanguage, input.detectedLanguage);
			const startedAt = Date.now();

			let response: Response;
			try {
				response = await requestOllamaChat({
					baseUrl: config.baseUrl,
					model: config.model,
					timeoutMs: config.timeoutMs,
					temperature: config.temperature,
					transcript,
					systemPrompts: buildSystemPromptLayers(input),
					conversationContext: input.conversationContext,
				});
			} catch (err) {
				if (err instanceof ResponseError) throw err;
				throw new ResponseError("GENERATION_FAILED", "Failed to request Ollama chat response.", {
					cause: err,
				});
			}

			if (!response.ok) {
				const message = await readErrorMessage(response);
				throw new ResponseError(
					"GENERATION_FAILED",
					`Ollama returned HTTP ${response.status}${message ? `: ${message}` : ""}.`,
				);
			}

			const payload = await parseJsonPayload(response);
			const content = extractMessageContent(payload);
			const text = normalizeWhitespace(content);
			if (!text) {
				throw new ResponseError("OUTPUT_INVALID", "Ollama returned an empty assistant message.");
			}

			return {
				text,
				language,
				provider: "ollama",
				model: config.model,
				durationMs: Date.now() - startedAt,
			};
		},
	};
}

export function buildSystemPromptLayers(input: ResponseInput): string[] {
	const customKernel = normalizeWhitespace(input.kernelPrompt ?? "");
	const persona = normalizeWhitespace(input.personaPrompt ?? "");

	const prompts: string[] = [];
	if (customKernel) {
		prompts.push(customKernel);
	} else {
		prompts.push(buildMvpSystemPrompt(input));
	}

	if (persona) prompts.push(persona);

	// Keep explicit language steering when custom kernel overrides the default prompt.
	if (customKernel) {
		const language = resolveResponseLanguage(input.requestedLanguage, input.detectedLanguage);
		prompts.push(buildLanguageInstruction(language));
	}

	return prompts;
}

export function buildMvpSystemPrompt(input: ResponseInput): string {
	const languageInstruction = buildLanguageInstruction(
		resolveResponseLanguage(input.requestedLanguage, input.detectedLanguage),
	);
	return [
		"You are Herzen, a calm local voice assistant.",
		"Reply briefly, clearly, and practically.",
		languageInstruction,
		"If unclear, ask one short clarification question.",
		"Do not claim that actions in external systems were completed.",
	].join(" ");
}

export function resolveResponseLanguage(
	requestedLanguage: ResponseInput["requestedLanguage"],
	detectedLanguage: string | undefined,
): ResponseLanguage {
	if (requestedLanguage && requestedLanguage !== "auto") return requestedLanguage;
	const detected = detectedLanguage?.trim().toLowerCase();
	if (detected?.startsWith("ru")) return "ru";
	return "en";
}

interface RequestOllamaChatOptions {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	temperature: number;
	systemPrompts: string[];
	transcript: string;
	conversationContext?: ConversationContextItem[];
}

interface OllamaChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OllamaChatRequest {
	model: string;
	stream: false;
	options: {
		temperature: number;
	};
	messages: OllamaChatMessage[];
}

const CONNECTION_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
]);

async function requestOllamaChat(options: RequestOllamaChatOptions): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);

	const url = `${options.baseUrl}/api/chat`;
	const body: OllamaChatRequest = {
		model: options.model,
		stream: false,
		options: {
			temperature: options.temperature,
		},
		messages: [
			...toSystemMessages(options.systemPrompts),
			...toContextMessages(options.conversationContext),
			{
				role: "user",
				content: options.transcript,
			},
		],
	};

	try {
		return await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err) {
		throw mapRequestError(err, {
			baseUrl: options.baseUrl,
			timeoutMs: options.timeoutMs,
			timedOut,
		});
	} finally {
		clearTimeout(timer);
	}
}

function toSystemMessages(
	systemPrompts: string[],
): Array<{ role: "system"; content: string }> {
	const messages: Array<{ role: "system"; content: string }> = [];
	for (const prompt of systemPrompts) {
		const content = prompt.trim();
		if (!content) continue;
		messages.push({
			role: "system",
			content,
		});
	}
	return messages;
}

function toContextMessages(
	conversationContext: ConversationContextItem[] | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
	if (!conversationContext || conversationContext.length === 0) return [];

	const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
	for (const item of conversationContext) {
		const content = item.text.trim();
		if (!content) continue;
		messages.push({
			role: item.role,
			content,
		});
	}

	return messages;
}

function mapRequestError(
	err: unknown,
	context: {
		baseUrl: string;
		timeoutMs: number;
		timedOut: boolean;
	},
): ResponseError {
	if (context.timedOut || isAbortError(err)) {
		return new ResponseError(
			"RUNTIME_UNAVAILABLE",
			`Timed out while contacting Ollama after ${context.timeoutMs}ms.`,
			{ cause: err },
		);
	}

	if (isConnectionFailure(err)) {
		return new ResponseError("RUNTIME_UNAVAILABLE", `Unable to reach Ollama at ${context.baseUrl}.`, {
			cause: err,
		});
	}

	return new ResponseError("GENERATION_FAILED", "Ollama request failed.", { cause: err });
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const body = await response.json();
		if (isRecord(body) && typeof body.error === "string") return normalizeWhitespace(body.error);
	} catch {
		// Fall through to text fallback.
	}

	try {
		const text = await response.text();
		return normalizeWhitespace(text);
	} catch {
		return "";
	}
}

async function parseJsonPayload(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (err) {
		throw new ResponseError("GENERATION_FAILED", "Ollama response was not valid JSON.", {
			cause: err,
		});
	}
}

function extractMessageContent(payload: unknown): string {
	if (!isRecord(payload)) {
		throw new ResponseError("OUTPUT_INVALID", "Ollama response payload is not an object.");
	}

	const message = payload.message;
	if (!isRecord(message)) {
		throw new ResponseError("OUTPUT_INVALID", "Ollama response payload is missing message object.");
	}

	if (typeof message.content !== "string") {
		throw new ResponseError("OUTPUT_INVALID", "Ollama response message content must be a string.");
	}

	return message.content;
}

function buildLanguageInstruction(language: ResponseLanguage): string {
	return language === "ru" ? "Respond in Russian." : "Respond in English.";
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAbortError(err: unknown): boolean {
	return isRecord(err) && err.name === "AbortError";
}

function isConnectionFailure(err: unknown): boolean {
	const code = extractErrorCode(err);
	if (code && CONNECTION_ERROR_CODES.has(code)) return true;

	if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;

	return false;
}

function extractErrorCode(err: unknown): string | undefined {
	let cursor: unknown = err;
	for (let depth = 0; depth < 5; depth += 1) {
		if (!isRecord(cursor)) return undefined;
		const code = cursor.code;
		if (typeof code === "string" && code) return code;
		if (!("cause" in cursor)) return undefined;
		cursor = cursor.cause;
	}
	return undefined;
}

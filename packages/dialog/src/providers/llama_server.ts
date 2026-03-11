import { resolveLlamaServerConfig } from "../config.js";
import {
	type ConversationContextItem,
	ResponseError,
	type ResponseInput,
	type ResponseOutput,
	type ResponseService,
} from "../types.js";
import { buildSystemPromptLayers, resolveResponseLanguage } from "./ollama.js";

export interface CreateLlamaServerResponseServiceOptions {
	env?: NodeJS.ProcessEnv;
}

export function createLlamaServerResponseService(
	options: CreateLlamaServerResponseServiceOptions = {},
): ResponseService {
	const config = resolveLlamaServerConfig(options.env ?? process.env);

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
				response = await requestLlamaServerChat({
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
				throw new ResponseError(
					"GENERATION_FAILED",
					"Failed to request llama-server chat response.",
					{
						cause: err,
					},
				);
			}

			if (!response.ok) {
				const message = await readErrorMessage(response);
				throw new ResponseError(
					"GENERATION_FAILED",
					`llama-server returned HTTP ${response.status}${message ? `: ${message}` : ""}.`,
				);
			}

			const payload = await parseJsonPayload(response);
			const content = extractMessageContent(payload);
			const text = normalizeWhitespace(content);
			if (!text) {
				throw new ResponseError("OUTPUT_INVALID", "llama-server returned an empty assistant message.");
			}

			return {
				text,
				language,
				provider: "llama-server",
				model: config.model,
				durationMs: Date.now() - startedAt,
			};
		},
	};
}

interface RequestLlamaServerChatOptions {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	temperature: number;
	systemPrompts: string[];
	transcript: string;
	conversationContext?: ConversationContextItem[];
}

interface LlamaServerChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface LlamaServerChatRequest {
	model: string;
	temperature: number;
	stream: false;
	reasoning_format: "none";
	enable_thinking: false;
	thinking_budget_tokens: 0;
	messages: LlamaServerChatMessage[];
}

const CONNECTION_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
]);

async function requestLlamaServerChat(options: RequestLlamaServerChatOptions): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);

	const url = `${options.baseUrl}/v1/chat/completions`;
	const body: LlamaServerChatRequest = {
		model: options.model,
		temperature: options.temperature,
		stream: false,
		reasoning_format: "none",
		enable_thinking: false,
		thinking_budget_tokens: 0,
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
	const normalizedPrompts = systemPrompts
		.map((prompt) => prompt.trim())
		.filter((prompt) => prompt.length > 0);
	if (normalizedPrompts.length === 0) return [];

	// Some llama.cpp chat templates only allow a single leading system message.
	return [
		{
			role: "system",
			content: normalizedPrompts.join("\n\n"),
		},
	];
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
			`Timed out while contacting llama-server after ${context.timeoutMs}ms.`,
			{ cause: err },
		);
	}

	if (isConnectionFailure(err)) {
		return new ResponseError(
			"RUNTIME_UNAVAILABLE",
			`Unable to reach llama-server at ${context.baseUrl}.`,
			{
				cause: err,
			},
		);
	}

	return new ResponseError("GENERATION_FAILED", "llama-server request failed.", { cause: err });
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const body = await response.json();
		if (!isRecord(body)) return "";
		if (typeof body.error === "string") return normalizeWhitespace(body.error);
		if (isRecord(body.error) && typeof body.error.message === "string") {
			return normalizeWhitespace(body.error.message);
		}
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
		throw new ResponseError("GENERATION_FAILED", "llama-server response was not valid JSON.", {
			cause: err,
		});
	}
}

function extractMessageContent(payload: unknown): string {
	if (!isRecord(payload)) {
		throw new ResponseError("OUTPUT_INVALID", "llama-server response payload is not an object.");
	}

	const choices = payload.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		throw new ResponseError("OUTPUT_INVALID", "llama-server response payload is missing choices array.");
	}

	const firstChoice = choices[0];
	if (!isRecord(firstChoice)) {
		throw new ResponseError("OUTPUT_INVALID", "llama-server response choice is invalid.");
	}

	const message = firstChoice.message;
	if (isRecord(message)) {
		const content = extractTextFromUnknown(message.content);
		if (content) return content;
		const reasoning = extractTextFromUnknown(
			message.reasoning_content ?? message.reasoning_text ?? message.reasoning,
		);
		if (reasoning) return reasoning;
	}

	const choiceText = extractTextFromUnknown(firstChoice.text);
	if (choiceText) return choiceText;
	const choiceDelta = extractTextFromUnknown(firstChoice.delta);
	if (choiceDelta) return choiceDelta;
	const choiceReasoning = extractTextFromUnknown(
		firstChoice.reasoning_content ?? firstChoice.reasoning_text ?? firstChoice.reasoning,
	);
	if (choiceReasoning) return choiceReasoning;

	throw new ResponseError(
		"OUTPUT_INVALID",
		"llama-server response choice is missing assistant text content.",
	);
}

function extractTextFromUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";

	const textParts: string[] = [];
	for (const part of value) {
		const text = extractTextPart(part);
		if (text) textParts.push(text);
	}
	return textParts.join(" ");
}

function extractTextPart(part: unknown): string {
	if (typeof part === "string") return part;
	if (!isRecord(part)) return "";
	if (typeof part.text === "string") return part.text;
	if (typeof part.content === "string") return part.content;
	if (typeof part.reasoning_text === "string") return part.reasoning_text;
	if (typeof part.reasoning_content === "string") return part.reasoning_content;
	if (typeof part.delta === "string") return part.delta;
	return "";
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

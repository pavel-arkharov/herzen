export type ResponseProvider = "ollama" | "llama-server";
export type ResponseLanguage = "en" | "ru";
export type RequestedResponseLanguage = "auto" | ResponseLanguage;

export interface ConversationContextItem {
	role: "user" | "assistant";
	text: string;
	language?: ResponseLanguage;
	turn?: number;
}

export interface ResponseInput {
	transcript: string;
	detectedLanguage?: string;
	requestedLanguage?: RequestedResponseLanguage;
	timestampIso: string;
	conversationContext?: ConversationContextItem[];
	kernelPrompt?: string;
	personaPrompt?: string;
}

export interface ResponseOutput {
	text: string;
	language: ResponseLanguage;
	provider: ResponseProvider;
	model: string;
	durationMs: number;
}

export type ResponseErrorCode =
	| "CONFIG_INVALID"
	| "RUNTIME_UNAVAILABLE"
	| "GENERATION_FAILED"
	| "OUTPUT_INVALID";

export interface ResponseErrorOptions {
	cause?: unknown;
}

export class ResponseError extends Error {
	readonly code: ResponseErrorCode;
	declare readonly cause?: unknown;

	constructor(code: ResponseErrorCode, message: string, options?: ResponseErrorOptions) {
		super(message);
		this.name = "ResponseError";
		this.code = code;
		this.cause = options?.cause;
	}
}

export interface ResponseService {
	generateReply(input: ResponseInput): Promise<ResponseOutput>;
}

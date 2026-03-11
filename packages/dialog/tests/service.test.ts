import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponseService } from "../src/service.js";
import {
	buildMvpSystemPrompt,
	buildSystemPromptLayers,
	resolveResponseLanguage,
} from "../src/providers/ollama.js";
import { ResponseError } from "../src/types.js";

const BASE_ENV = {
	HERZEN_OLLAMA_MODEL: "qwen2.5:3b",
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("createResponseService", () => {
	it("creates an ollama service by default", () => {
		const service = createResponseService({ env: BASE_ENV });
		expect(service).toBeDefined();
		expect(typeof service.generateReply).toBe("function");
	});

	it("returns OUTPUT_INVALID for empty transcript", async () => {
		const service = createResponseService({ env: BASE_ENV });

		await expect(
			service.generateReply({
				transcript: "   ",
				detectedLanguage: "en",
				timestampIso: "2026-02-19T12:00:00.000Z",
			}),
		).rejects.toMatchObject<ResponseError>({
			code: "OUTPUT_INVALID",
		});
	});

	it("returns model reply when ollama succeeds", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					message: {
						role: "assistant",
						content: "  Hello there.   How can I help? ",
					},
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = createResponseService({ env: BASE_ENV });
		const output = await service.generateReply({
			transcript: "Turn on the hallway lights.",
			detectedLanguage: "en",
			timestampIso: "2026-02-19T12:00:00.000Z",
		});

		expect(output).toMatchObject({
			text: "Hello there. How can I help?",
			language: "en",
			provider: "ollama",
			model: "qwen2.5:3b",
		});
		expect(output.durationMs).toBeGreaterThanOrEqual(0);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:11434/api/chat");
		expect(init.method).toBe("POST");
		const body = JSON.parse(String(init.body)) as {
			model: string;
			stream: boolean;
			options: { temperature: number };
			messages: Array<{ role: string; content: string }>;
		};
		expect(body.model).toBe("qwen2.5:3b");
		expect(body.stream).toBe(false);
		expect(body.options.temperature).toBe(0.2);
		expect(body.messages[0]?.role).toBe("system");
		expect(body.messages[1]?.role).toBe("user");
		expect(body.messages[1]?.content).toBe("Turn on the hallway lights.");
	});

	it("injects conversation context before the current user message", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					message: {
						role: "assistant",
						content: "Sure.",
					},
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = createResponseService({ env: BASE_ENV });
		await service.generateReply({
			transcript: "What is my name?",
			detectedLanguage: "en",
			timestampIso: "2026-02-19T12:00:00.000Z",
			conversationContext: [
				{
					role: "user",
					text: "My name is Pavel.",
					turn: 1,
				},
				{
					role: "assistant",
					text: "Nice to meet you, Pavel.",
					turn: 1,
				},
			],
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};

		expect(body.messages).toEqual([
			expect.objectContaining({ role: "system" }),
			{ role: "user", content: "My name is Pavel." },
			{ role: "assistant", content: "Nice to meet you, Pavel." },
			{ role: "user", content: "What is my name?" },
		]);
	});

	it("injects kernel + persona system layers before context and user message", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					message: {
						role: "assistant",
						content: "Understood.",
					},
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const service = createResponseService({ env: BASE_ENV });
		await service.generateReply({
			transcript: "Summarize my day.",
			detectedLanguage: "en",
			timestampIso: "2026-03-01T12:00:00.000Z",
			kernelPrompt: "You are an honest local assistant.",
			personaPrompt: "Address the user as sir and be polite.",
			conversationContext: [{ role: "user", text: "I had a gym workout.", turn: 1 }],
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body)) as {
			messages: Array<{ role: string; content: string }>;
		};

		expect(body.messages).toEqual([
			{ role: "system", content: "You are an honest local assistant." },
			{
				role: "system",
				content: expect.stringContaining("Persona acting mode is enabled."),
			},
			{ role: "system", content: "Respond in English." },
			{ role: "user", content: "I had a gym workout." },
			{ role: "user", content: "Summarize my day." },
		]);
		expect(body.messages[1]?.content).toContain("Persona card: Address the user as sir and be polite.");
	});

	it("maps timeout/abort failures to RUNTIME_UNAVAILABLE", async () => {
		const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw abortErr;
			}),
		);

		const service = createResponseService({ env: BASE_ENV });
		await expect(
			service.generateReply({
				transcript: "Ping",
				detectedLanguage: "en",
				timestampIso: "2026-02-19T12:00:00.000Z",
			}),
		).rejects.toMatchObject<ResponseError>({
			code: "RUNTIME_UNAVAILABLE",
		});
	});

	it("maps non-200 responses to GENERATION_FAILED", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
			}),
		);

		const service = createResponseService({ env: BASE_ENV });
		await expect(
			service.generateReply({
				transcript: "Ping",
				detectedLanguage: "en",
				timestampIso: "2026-02-19T12:00:00.000Z",
			}),
		).rejects.toMatchObject<ResponseError>({
			code: "GENERATION_FAILED",
		});
	});

	it("maps malformed payloads to OUTPUT_INVALID", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify({ message: { role: "assistant" } }), { status: 200 });
			}),
		);

		const service = createResponseService({ env: BASE_ENV });
		await expect(
			service.generateReply({
				transcript: "Ping",
				detectedLanguage: "en",
				timestampIso: "2026-02-19T12:00:00.000Z",
			}),
		).rejects.toMatchObject<ResponseError>({
			code: "OUTPUT_INVALID",
		});
	});

	it("maps empty outputs to OUTPUT_INVALID", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({
						message: { role: "assistant", content: " \n\t " },
					}),
					{ status: 200 },
				);
			}),
		);

		const service = createResponseService({ env: BASE_ENV });
		await expect(
			service.generateReply({
				transcript: "Ping",
				detectedLanguage: "en",
				timestampIso: "2026-02-19T12:00:00.000Z",
			}),
		).rejects.toMatchObject<ResponseError>({
			code: "OUTPUT_INVALID",
		});
	});
});

describe("buildMvpSystemPrompt", () => {
	it("uses explicit requested language when provided", () => {
		const prompt = buildMvpSystemPrompt({
			transcript: "Привет",
			requestedLanguage: "ru",
			timestampIso: "2026-02-19T12:00:00.000Z",
		});

		expect(prompt).toContain("Respond in Russian.");
	});
});

describe("buildSystemPromptLayers", () => {
	it("falls back to the default single system prompt without custom kernel/persona", () => {
		const prompts = buildSystemPromptLayers({
			transcript: "Hello",
			requestedLanguage: "en",
			timestampIso: "2026-03-01T12:00:00.000Z",
		});
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("You are Herzen, a local voice assistant.");
	});
});

describe("resolveResponseLanguage", () => {
	it("uses requested language first", () => {
		expect(resolveResponseLanguage("ru", "en")).toBe("ru");
	});

	it("falls back to detected ru language", () => {
		expect(resolveResponseLanguage("auto", "ru-RU")).toBe("ru");
	});

	it("defaults to english", () => {
		expect(resolveResponseLanguage("auto", "en-US")).toBe("en");
	});
});

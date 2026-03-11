import { describe, expect, it } from "vitest";
import {
	resolveLlamaServerConfig,
	resolveOllamaConfig,
	resolveResponseProvider,
} from "../src/config.js";
import { ResponseError } from "../src/types.js";

describe("resolveResponseProvider", () => {
	it("defaults to ollama when unset", () => {
		expect(resolveResponseProvider(undefined)).toBe("ollama");
	});

	it("rejects unsupported provider values", () => {
		expect(() => resolveResponseProvider("localai")).toThrowError(ResponseError);
		expect(() => resolveResponseProvider("localai")).toThrow(
			/Supported values: ollama, llama-server/,
		);
	});

	it("accepts llama-server providers", () => {
		expect(resolveResponseProvider("llama-server")).toBe("llama-server");
		expect(resolveResponseProvider("llama_server")).toBe("llama-server");
	});
});

describe("resolveOllamaConfig", () => {
	it("resolves defaults for loopback url", () => {
		const config = resolveOllamaConfig({
			HERZEN_OLLAMA_MODEL: "qwen2.5:3b",
		});

		expect(config.baseUrl).toBe("http://127.0.0.1:11434");
		expect(config.model).toBe("qwen2.5:3b");
		expect(config.timeoutMs).toBe(12_000);
		expect(config.temperature).toBe(0.2);
	});

	it("requires model", () => {
		expect(() => resolveOllamaConfig({})).toThrowError(ResponseError);
		expect(() => resolveOllamaConfig({})).toThrow(/HERZEN_OLLAMA_MODEL is required/);
	});

	it("rejects non-loopback base url by default", () => {
		expect(() =>
			resolveOllamaConfig({
				HERZEN_OLLAMA_MODEL: "qwen2.5:3b",
				HERZEN_OLLAMA_BASE_URL: "http://192.168.1.50:11434",
			}),
		).toThrowError(ResponseError);
	});

	it("allows remote base url when explicitly enabled", () => {
		const config = resolveOllamaConfig({
			HERZEN_OLLAMA_MODEL: "qwen2.5:3b",
			HERZEN_OLLAMA_BASE_URL: "http://192.168.1.50:11434",
			HERZEN_ALLOW_REMOTE_LLM: "1",
		});

		expect(config.baseUrl).toBe("http://192.168.1.50:11434");
	});
});

describe("resolveLlamaServerConfig", () => {
	it("resolves defaults for loopback url", () => {
		const config = resolveLlamaServerConfig({});

		expect(config.baseUrl).toBe("http://127.0.0.1:8080");
		expect(config.model).toBe("llama-server");
		expect(config.timeoutMs).toBe(12_000);
		expect(config.temperature).toBe(0.2);
	});

	it("uses explicit model when provided", () => {
		const config = resolveLlamaServerConfig({
			HERZEN_LLAMA_SERVER_MODEL: "Qwen3.5-9B-Uncensored",
		});

		expect(config.model).toBe("Qwen3.5-9B-Uncensored");
	});

	it("rejects non-loopback base url by default", () => {
		expect(() =>
			resolveLlamaServerConfig({
				HERZEN_LLAMA_SERVER_BASE_URL: "http://192.168.1.50:8080",
			}),
		).toThrowError(ResponseError);
	});

	it("allows remote base url when explicitly enabled", () => {
		const config = resolveLlamaServerConfig({
			HERZEN_LLAMA_SERVER_BASE_URL: "http://192.168.1.50:8080",
			HERZEN_ALLOW_REMOTE_LLM: "1",
		});

		expect(config.baseUrl).toBe("http://192.168.1.50:8080");
	});
});

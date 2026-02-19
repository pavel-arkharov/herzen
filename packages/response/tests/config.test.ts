import { describe, expect, it } from "vitest";
import { resolveOllamaConfig, resolveResponseProvider } from "../src/config.js";
import { ResponseError } from "../src/types.js";

describe("resolveResponseProvider", () => {
	it("defaults to ollama when unset", () => {
		expect(resolveResponseProvider(undefined)).toBe("ollama");
	});

	it("rejects unsupported provider values", () => {
		expect(() => resolveResponseProvider("localai")).toThrowError(ResponseError);
		expect(() => resolveResponseProvider("localai")).toThrow(/Supported values: ollama/);
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

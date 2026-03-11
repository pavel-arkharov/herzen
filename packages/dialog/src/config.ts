import { ResponseError, type ResponseProvider } from "./types.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_LLAMA_SERVER_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_RESPONSE_TIMEOUT_MS = 12_000;
const DEFAULT_RESPONSE_TEMPERATURE = 0.2;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface OllamaConfig {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	temperature: number;
}

export interface LlamaServerConfig {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	temperature: number;
}

export function resolveResponseProvider(rawProvider = process.env.HERZEN_RESPONSE_PROVIDER): ResponseProvider {
	const normalized = rawProvider?.trim().toLowerCase();
	if (!normalized) return "ollama";
	if (normalized === "ollama") return normalized;
	if (normalized === "llama-server" || normalized === "llama_server") return "llama-server";

	throw new ResponseError(
		"CONFIG_INVALID",
		`Unsupported HERZEN_RESPONSE_PROVIDER "${rawProvider}". Supported values: ollama, llama-server.`,
	);
}

export function resolveOllamaConfig(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
	const model = env.HERZEN_OLLAMA_MODEL?.trim();
	if (!model) {
		throw new ResponseError(
			"CONFIG_INVALID",
			"HERZEN_OLLAMA_MODEL is required for @herzen/dialog when provider=ollama.",
		);
	}

	const baseUrl = resolveRuntimeBaseUrl({
		rawBaseUrl: env.HERZEN_OLLAMA_BASE_URL,
		defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
		baseUrlEnvName: "HERZEN_OLLAMA_BASE_URL",
		allowRemoteFlag: env.HERZEN_ALLOW_REMOTE_LLM,
	});
	const { timeoutMs, temperature } = resolveSharedResponseParams(env);

	return {
		baseUrl,
		model,
		timeoutMs,
		temperature,
	};
}

export function resolveLlamaServerConfig(
	env: NodeJS.ProcessEnv = process.env,
): LlamaServerConfig {
	const baseUrl = resolveRuntimeBaseUrl({
		rawBaseUrl: env.HERZEN_LLAMA_SERVER_BASE_URL,
		defaultBaseUrl: DEFAULT_LLAMA_SERVER_BASE_URL,
		baseUrlEnvName: "HERZEN_LLAMA_SERVER_BASE_URL",
		allowRemoteFlag: env.HERZEN_ALLOW_REMOTE_LLM,
	});
	const model =
		env.HERZEN_LLAMA_SERVER_MODEL?.trim() ||
		env.HERZEN_RESPONSE_MODEL?.trim() ||
		"llama-server";
	const { timeoutMs, temperature } = resolveSharedResponseParams(env);

	return {
		baseUrl,
		model,
		timeoutMs,
		temperature,
	};
}

function resolveSharedResponseParams(env: NodeJS.ProcessEnv): {
	timeoutMs: number;
	temperature: number;
} {
	const timeoutMs = resolvePositiveInteger(
		env.HERZEN_RESPONSE_TIMEOUT_MS,
		DEFAULT_RESPONSE_TIMEOUT_MS,
		"HERZEN_RESPONSE_TIMEOUT_MS",
	);

	const temperature = resolveNumberInRange(
		env.HERZEN_RESPONSE_TEMPERATURE,
		DEFAULT_RESPONSE_TEMPERATURE,
		"HERZEN_RESPONSE_TEMPERATURE",
		0,
		2,
	);

	return { timeoutMs, temperature };
}

function resolveRuntimeBaseUrl(input: {
	rawBaseUrl: string | undefined;
	defaultBaseUrl: string;
	baseUrlEnvName: string;
	allowRemoteFlag: string | undefined;
}): string {
	const baseUrlRaw = input.rawBaseUrl?.trim() || input.defaultBaseUrl;
	const baseUrl = normalizeBaseUrl(baseUrlRaw, input.baseUrlEnvName);
	const allowRemote = parseBooleanFlag(input.allowRemoteFlag);
	if (!allowRemote && !isLoopbackUrl(baseUrl)) {
		throw new ResponseError(
			"CONFIG_INVALID",
			`${input.baseUrlEnvName} must use loopback host by default (received "${baseUrl}"). Set HERZEN_ALLOW_REMOTE_LLM=1 to override.`,
		);
	}
	return baseUrl;
}

function normalizeBaseUrl(rawBaseUrl: string, envName: string): string {
	let parsed: URL;
	try {
		parsed = new URL(rawBaseUrl);
	} catch (err) {
		throw new ResponseError(
			"CONFIG_INVALID",
			`Invalid ${envName} "${rawBaseUrl}". Expected valid http(s) URL.`,
			{ cause: err },
		);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ResponseError(
			"CONFIG_INVALID",
			`Invalid ${envName} protocol "${parsed.protocol}". Expected http or https.`,
		);
	}

	return parsed.toString().replace(/\/$/, "");
}

function parseBooleanFlag(rawFlag: string | undefined): boolean {
	const normalized = rawFlag?.trim().toLowerCase();
	if (!normalized) return false;
	return TRUE_VALUES.has(normalized);
}

function isLoopbackUrl(baseUrl: string): boolean {
	const parsed = new URL(baseUrl);
	const hostname = parsed.hostname.toLowerCase();
	if (LOOPBACK_HOSTS.has(hostname)) return true;
	return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function resolvePositiveInteger(rawValue: string | undefined, fallback: number, envName: string): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new ResponseError(
			"CONFIG_INVALID",
			`${envName} must be a positive integer (received "${rawValue}").`,
		);
	}
	return parsed;
}

function resolveNumberInRange(
	rawValue: string | undefined,
	fallback: number,
	envName: string,
	min: number,
	max: number,
): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		throw new ResponseError(
			"CONFIG_INVALID",
			`${envName} must be between ${min} and ${max} (received "${rawValue}").`,
		);
	}
	return parsed;
}

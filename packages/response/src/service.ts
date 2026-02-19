import { resolveResponseProvider } from "./config.js";
import { createOllamaResponseService } from "./providers/ollama.js";
import { type ResponseProvider, type ResponseService } from "./types.js";

export interface CreateResponseServiceOptions {
	provider?: ResponseProvider;
	env?: NodeJS.ProcessEnv;
}

export function createResponseService(options: CreateResponseServiceOptions = {}): ResponseService {
	const env = options.env ?? process.env;
	const provider = options.provider ?? resolveResponseProvider(env.HERZEN_RESPONSE_PROVIDER);

	if (provider === "ollama") {
		return createOllamaResponseService({ env });
	}

	/* c8 ignore next */
	throw new Error(`Unsupported response provider: ${provider}`);
}

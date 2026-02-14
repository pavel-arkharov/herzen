import { createWakewordClient, type WakewordClient } from "@herzen/wakeword";
import { TriggerError, type TriggerEvent, type TriggerSource } from "./types.js";

export class WakeWordTriggerSource implements TriggerSource {
	private client: WakewordClient | null = null;
	private started = false;

	constructor(private readonly makeClient: () => WakewordClient = createWakewordClient) {}

	async start(): Promise<void> {
		if (this.started) return;

		const client = this.makeClient();
		this.client = client;
		try {
			await client.start();
			this.started = true;
		} catch (err) {
			this.client = null;
			throw mapClientError(err, "Failed to start wakeword trigger source.");
		}
	}

	async nextTrigger(): Promise<TriggerEvent> {
		if (!this.started || !this.client) {
			throw new TriggerError("SOURCE_FAILED", "Wakeword trigger source is not started.");
		}

		try {
			await this.client.nextDetection();
		} catch (err) {
			throw mapClientError(err, "Wakeword trigger source failed.");
		}

		return {
			kind: "wakeword",
			mode: "wakeword",
			timestamp: Date.now(),
		};
	}

	async stop(): Promise<void> {
		const client = this.client;
		this.client = null;
		this.started = false;
		if (!client) return;

		try {
			await client.stop();
		} catch {
			// Core shutdown should not fail on trigger cleanup errors.
		}
	}
}

function mapClientError(err: unknown, fallbackMessage: string): TriggerError {
	const clientCode = getClientErrorCode(err);
	const message = getErrorMessage(err, fallbackMessage);

	if (clientCode === "SOURCE_CLOSED") {
		return new TriggerError("SOURCE_CLOSED", message, { cause: err });
	}

	return new TriggerError("SOURCE_FAILED", message, { cause: err });
}

function getClientErrorCode(err: unknown): string | null {
	if (!err || typeof err !== "object" || !("code" in err)) return null;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

function getErrorMessage(err: unknown, fallbackMessage: string): string {
	if (err instanceof Error && err.message) return err.message;
	if (typeof err === "string" && err) return err;
	return fallbackMessage;
}

export type TriggerMode = "stdin" | "wakeword";

export type TriggerKind = "manual" | "wakeword";

export type TriggerErrorCode = "SOURCE_CLOSED" | "SOURCE_FAILED";

export interface TriggerEvent {
	kind: TriggerKind;
	mode: TriggerMode;
	timestamp: number;
}

export interface TriggerSource {
	start(): Promise<void> | void;
	nextTrigger(): Promise<TriggerEvent>;
	stop(): Promise<void> | void;
}

export class TriggerError extends Error {
	readonly code: TriggerErrorCode;

	constructor(code: TriggerErrorCode, message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = "TriggerError";
		this.code = code;
		if (options && "cause" in options) {
			(this as Error & { cause?: unknown }).cause = options.cause;
		}
	}
}

export function isTriggerError(err: unknown): err is TriggerError {
	return err instanceof TriggerError;
}

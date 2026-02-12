import { TriggerError, type TriggerEvent, type TriggerSource } from "./types.js";

export class WakeWordTriggerSource implements TriggerSource {
	start() {
		// Placeholder for future wake word detector setup.
	}

	async nextTrigger(): Promise<TriggerEvent> {
		throw new TriggerError(
			"NOT_IMPLEMENTED",
			"Wake word trigger mode is not implemented yet. Use HERZEN_TRIGGER_MODE=stdin for now.",
		);
	}

	stop() {
		// Placeholder for future wake word detector cleanup.
	}
}

import type { TriggerError, TriggerMode, TriggerSource } from "./trigger/types.js";

export interface RuntimeLogger {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export interface RuntimeDependencies {
	resolveTriggerMode: () => TriggerMode;
	createTriggerSource: (mode: TriggerMode) => TriggerSource;
	isTriggerError: (err: unknown) => err is TriggerError;
	onTrigger: () => Promise<void>;
	logger: RuntimeLogger;
	exit: (code: number) => void | Promise<void>;
}

export interface RuntimeController {
	run: () => Promise<void>;
	shutdown: (code?: number) => Promise<void>;
}

export function listeningMessage(mode: TriggerMode): string {
	if (mode === "stdin") return "\nListening… (press Enter to trigger)";
	return `\nListening… (trigger mode: ${mode})`;
}

export function createRuntime(deps: RuntimeDependencies): RuntimeController {
	let triggerSource: TriggerSource | null = null;
	let shuttingDown = false;

	const shutdown = async (code = 0): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;

		try {
			await triggerSource?.stop();
		} catch (err) {
			deps.logger.error("Trigger source cleanup error:", err);
		}

		await Promise.resolve(deps.exit(code));
	};

	const run = async (): Promise<void> => {
		let triggerMode: TriggerMode;
		try {
			triggerMode = deps.resolveTriggerMode();
		} catch (err) {
			deps.logger.error(err instanceof Error ? err.message : "Unknown trigger mode resolution error.");
			await shutdown(1);
			return;
		}

		triggerSource = deps.createTriggerSource(triggerMode);

		try {
			await triggerSource.start();
		} catch (err) {
			if (deps.isTriggerError(err)) {
				deps.logger.error(`Failed to start trigger source (${err.code}): ${err.message}`);
			} else {
				deps.logger.error("Failed to start trigger source:", err);
			}
			await shutdown(1);
			return;
		}

		deps.logger.log(`Trigger mode: ${triggerMode}`);
		deps.logger.log(listeningMessage(triggerMode));

		while (!shuttingDown) {
			try {
				await triggerSource.nextTrigger();
				await deps.onTrigger();
				deps.logger.log(listeningMessage(triggerMode));
			} catch (err) {
				if (shuttingDown) return;

				if (deps.isTriggerError(err)) {
					if (err.code === "SOURCE_CLOSED") {
						await shutdown(0);
						return;
					}

					if (err.code === "SOURCE_FAILED") {
						deps.logger.error(`Trigger source error: ${err.message}`);
						await shutdown(1);
						return;
					}
				}

				deps.logger.error("Error:", err);
				deps.logger.log(listeningMessage(triggerMode));
			}
		}
	};

	return {
		run,
		shutdown,
	};
}

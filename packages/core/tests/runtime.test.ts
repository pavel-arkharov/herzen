import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { TriggerError, type TriggerEvent, type TriggerMode, type TriggerSource } from "../src/trigger/types.js";

class SequenceTriggerSource implements TriggerSource {
	readonly start = vi.fn(async () => {});
	readonly stop = vi.fn(async () => {});

	private readonly steps: Array<TriggerEvent | Error>;

	constructor(steps: Array<TriggerEvent | Error>) {
		this.steps = [...steps];
	}

	async nextTrigger(): Promise<TriggerEvent> {
		const step = this.steps.shift();
		if (!step) {
			throw new TriggerError("SOURCE_CLOSED", "No more trigger events.");
		}
		if (step instanceof Error) {
			throw step;
		}
		return step;
	}
}

function makeEvent(mode: TriggerMode = "stdin"): TriggerEvent {
	return {
		kind: mode === "stdin" ? "manual" : "wakeword",
		mode,
		timestamp: Date.now(),
	};
}

describe("createRuntime", () => {
	it("runs one trigger cycle successfully before clean source close", async () => {
		const source = new SequenceTriggerSource([
			makeEvent("stdin"),
			new TriggerError("SOURCE_CLOSED", "closed"),
		]);
		const onTrigger = vi.fn(async () => {});
		const exit = vi.fn();
		const logger = {
			log: vi.fn(),
			error: vi.fn(),
		};

		const runtime = createRuntime({
			resolveTriggerMode: () => "stdin",
			createTriggerSource: () => source,
			isTriggerError: (err): err is TriggerError => err instanceof TriggerError,
			onTrigger,
			logger,
			exit,
		});

		await runtime.run();

		expect(source.start).toHaveBeenCalledTimes(1);
		expect(onTrigger).toHaveBeenCalledTimes(1);
		expect(source.stop).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("exits cleanly when source closes before any trigger", async () => {
		const source = new SequenceTriggerSource([new TriggerError("SOURCE_CLOSED", "closed")]);
		const exit = vi.fn();
		const onTrigger = vi.fn(async () => {});

		const runtime = createRuntime({
			resolveTriggerMode: () => "stdin",
			createTriggerSource: () => source,
			isTriggerError: (err): err is TriggerError => err instanceof TriggerError,
			onTrigger,
			logger: { log: vi.fn(), error: vi.fn() },
			exit,
		});

		await runtime.run();

		expect(onTrigger).not.toHaveBeenCalled();
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("exits with failure on SOURCE_FAILED trigger error", async () => {
		const source = new SequenceTriggerSource([new TriggerError("SOURCE_FAILED", "read failure")]);
		const logger = {
			log: vi.fn(),
			error: vi.fn(),
		};
		const exit = vi.fn();

		const runtime = createRuntime({
			resolveTriggerMode: () => "stdin",
			createTriggerSource: () => source,
			isTriggerError: (err): err is TriggerError => err instanceof TriggerError,
			onTrigger: vi.fn(async () => {}),
			logger,
			exit,
		});

		await runtime.run();

		expect(logger.error).toHaveBeenCalledWith("Trigger source error: read failure");
		expect(exit).toHaveBeenCalledWith(1);
	});
});

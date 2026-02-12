import { beforeEach, describe, expect, it, vi } from "vitest";

const { createInterfaceMock, getLastInterface, resetInterfaces } = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class FakeReadlineInterface {
		private listeners = new Map<string, Array<Listener>>();

		on(event: string, listener: Listener) {
			const next = this.listeners.get(event) ?? [];
			next.push(listener);
			this.listeners.set(event, next);
			return this;
		}

		once(event: string, listener: Listener) {
			const onceListener: Listener = (...args) => {
				this.off(event, onceListener);
				listener(...args);
			};
			return this.on(event, onceListener);
		}

		off(event: string, listener: Listener) {
			const current = this.listeners.get(event) ?? [];
			this.listeners.set(
				event,
				current.filter((candidate) => candidate !== listener),
			);
			return this;
		}

		emit(event: string, ...args: unknown[]) {
			for (const listener of this.listeners.get(event) ?? []) {
				listener(...args);
			}
		}

		close() {
			this.emit("close");
		}
	}

	const instances: FakeReadlineInterface[] = [];
	const createInterfaceMock = vi.fn(() => {
		const rl = new FakeReadlineInterface();
		instances.push(rl);
		return rl;
	});

	return {
		createInterfaceMock,
		getLastInterface: () => instances.at(-1) ?? null,
		resetInterfaces: () => {
			instances.length = 0;
			createInterfaceMock.mockClear();
		},
	};
});

vi.mock("node:readline", () => ({
	default: {
		createInterface: createInterfaceMock,
	},
}));

import { StdinTriggerSource } from "../src/trigger/stdin.js";

describe("StdinTriggerSource", () => {
	beforeEach(() => {
		resetInterfaces();
	});

	it("throws when nextTrigger is called before start", async () => {
		const source = new StdinTriggerSource();
		await expect(source.nextTrigger()).rejects.toMatchObject({ code: "SOURCE_FAILED" });
	});

	it("starts once even when called multiple times", () => {
		const source = new StdinTriggerSource();

		source.start();
		source.start();
		source.stop();

		expect(createInterfaceMock).toHaveBeenCalledTimes(1);
	});

	it("resolves trigger event when a line is received", async () => {
		const source = new StdinTriggerSource();
		source.start();

		const rl = getLastInterface();
		expect(rl).not.toBeNull();

		const pending = source.nextTrigger();
		rl?.emit("line");

		await expect(pending).resolves.toMatchObject({
			kind: "manual",
			mode: "stdin",
		});

		source.stop();
	});

	it("rejects second nextTrigger while one call is pending", async () => {
		const source = new StdinTriggerSource();
		source.start();

		const rl = getLastInterface();
		const first = source.nextTrigger();
		await expect(source.nextTrigger()).rejects.toMatchObject({ code: "SOURCE_FAILED" });

		rl?.emit("line");
		await first;
		source.stop();
	});

	it("rejects pending trigger when the source is stopped", async () => {
		const source = new StdinTriggerSource();
		source.start();

		const pending = source.nextTrigger();
		source.stop();

		await expect(pending).rejects.toMatchObject({ code: "SOURCE_CLOSED" });
	});

	it("maps stdin EIO error to SOURCE_CLOSED", async () => {
		const source = new StdinTriggerSource();
		source.start();

		const pending = source.nextTrigger();
		const eioErr = Object.assign(new Error("stdin closed"), { code: "EIO" });
		process.stdin.emit("error", eioErr);

		await expect(pending).rejects.toMatchObject({ code: "SOURCE_CLOSED" });
		await expect(source.nextTrigger()).rejects.toMatchObject({ code: "SOURCE_CLOSED" });
		source.stop();
	});

	it("maps non-EIO stdin error to SOURCE_FAILED", async () => {
		const source = new StdinTriggerSource();
		source.start();

		const pending = source.nextTrigger();
		const ioErr = Object.assign(new Error("stdin failed"), { code: "EPERM" });
		process.stdin.emit("error", ioErr);

		await expect(pending).rejects.toMatchObject({ code: "SOURCE_FAILED" });
		await expect(source.nextTrigger()).rejects.toMatchObject({ code: "SOURCE_FAILED" });
		source.stop();
	});

	it("rejects pending trigger when readline interface closes", async () => {
		const source = new StdinTriggerSource();
		source.start();

		const pending = source.nextTrigger();
		const rl = getLastInterface();
		rl?.close();

		await expect(pending).rejects.toMatchObject({ code: "SOURCE_CLOSED" });
		await expect(source.nextTrigger()).rejects.toMatchObject({ code: "SOURCE_CLOSED" });
		source.stop();
	});
});

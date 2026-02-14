import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createWakewordClient: vi.fn(),
}));

vi.mock("@herzen/wakeword", () => ({
	createWakewordClient: mocks.createWakewordClient,
}));

import { WakeWordTriggerSource } from "../src/trigger/wakeword.js";

interface FakeWakewordClient {
	start: ReturnType<typeof vi.fn>;
	nextDetection: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

function makeClient(): FakeWakewordClient {
	return {
		start: vi.fn(async () => {}),
		nextDetection: vi.fn(async () => ({
			keyword: "herzen",
			score: 0.7,
			threshold: 0.5,
			timestamp: Date.now(),
			sourceTimestamp: new Date().toISOString(),
		})),
		stop: vi.fn(async () => {}),
	};
}

describe("WakeWordTriggerSource", () => {
	beforeEach(() => {
		mocks.createWakewordClient.mockReset();
	});

	it("maps wakeword detection to trigger event", async () => {
		const client = makeClient();
		mocks.createWakewordClient.mockReturnValue(client);
		const source = new WakeWordTriggerSource();
		await source.start();

		await expect(source.nextTrigger()).resolves.toMatchObject({
			kind: "wakeword",
			mode: "wakeword",
		});

		expect(client.start).toHaveBeenCalledTimes(1);
		expect(client.nextDetection).toHaveBeenCalledTimes(1);
	});

	it("maps SOURCE_CLOSED from client into trigger SOURCE_CLOSED", async () => {
		const client = makeClient();
		client.nextDetection.mockRejectedValue({ code: "SOURCE_CLOSED", message: "daemon closed" });
		mocks.createWakewordClient.mockReturnValue(client);

		const source = new WakeWordTriggerSource();
		await source.start();

		await expect(source.nextTrigger()).rejects.toMatchObject({
			name: "TriggerError",
			code: "SOURCE_CLOSED",
		});
	});

	it("maps client protocol failure into trigger SOURCE_FAILED", async () => {
		const client = makeClient();
		client.nextDetection.mockRejectedValue({ code: "PROTOCOL_ERROR", message: "bad payload" });
		mocks.createWakewordClient.mockReturnValue(client);

		const source = new WakeWordTriggerSource();
		await source.start();

		await expect(source.nextTrigger()).rejects.toMatchObject({
			name: "TriggerError",
			code: "SOURCE_FAILED",
		});
	});

	it("maps startup socket failure into trigger SOURCE_FAILED", async () => {
		const client = makeClient();
		client.start.mockRejectedValue({ code: "SOCKET_UNAVAILABLE", message: "connect failed" });
		mocks.createWakewordClient.mockReturnValue(client);

		const source = new WakeWordTriggerSource();

		await expect(source.start()).rejects.toMatchObject({
			name: "TriggerError",
			code: "SOURCE_FAILED",
		});
	});

	it("keeps start/stop idempotent", async () => {
		const client = makeClient();
		mocks.createWakewordClient.mockReturnValue(client);

		const source = new WakeWordTriggerSource();
		await source.start();
		await source.start();
		await source.stop();
		await source.stop();

		expect(client.start).toHaveBeenCalledTimes(1);
		expect(client.stop).toHaveBeenCalledTimes(1);
	});
});

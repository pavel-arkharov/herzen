import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

class FakeSocket {
	private listeners = new Map<string, Array<Listener>>();
	readonly destroy = vi.fn();

	on(event: string, listener: Listener) {
		const next = this.listeners.get(event) ?? [];
		next.push(listener);
		this.listeners.set(event, next);
		return this;
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
}

const mocks = vi.hoisted(() => {
	const sockets: FakeSocket[] = [];
	const createConnection = vi.fn(() => {
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket;
	});

	return {
		createConnection,
		getLastSocket: () => sockets.at(-1) ?? null,
		reset: () => {
			sockets.length = 0;
			createConnection.mockClear();
		},
	};
});

vi.mock("node:net", () => ({
	createConnection: mocks.createConnection,
}));

import {
	WakewordClientError,
	createWakewordClient,
	resolveWakewordConnectTimeoutMs,
	resolveWakewordSocketPath,
} from "../src/index.js";

describe("@herzen/wakeword", () => {
	beforeEach(() => {
		mocks.reset();

		delete process.env.HERZEN_WAKEWORD_SOCKET;
		delete process.env.HERZEN_WAKEWORD_CONNECT_TIMEOUT_MS;
		delete process.env.HERZEN_DATA_DIR;
	});

	it("resolves default socket path to data/run/wakeword.sock", () => {
		const socketPath = resolveWakewordSocketPath(undefined, undefined);
		expect(socketPath.endsWith("/data/run/wakeword.sock")).toBe(true);
	});

	it("uses explicit socket path and timeout values", () => {
		expect(resolveWakewordSocketPath("/tmp/custom.sock", undefined)).toBe("/tmp/custom.sock");
		expect(resolveWakewordConnectTimeoutMs("4500")).toBe(4500);
	});

	it("throws CONFIG_INVALID for invalid timeout values", () => {
		expect(() => resolveWakewordConnectTimeoutMs("0")).toThrowError(WakewordClientError);
		expect(() => resolveWakewordConnectTimeoutMs("0")).toThrow(
			expect.objectContaining({ code: "CONFIG_INVALID" }),
		);
	});

	it("maps connection failure to SOCKET_UNAVAILABLE", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const pendingStart = client.start();

		const socket = mocks.getLastSocket();
		expect(socket).not.toBeNull();
		socket?.emit("error", Object.assign(new Error("missing socket"), { code: "ENOENT" }));

		await expect(pendingStart).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "SOCKET_UNAVAILABLE",
		});
	});

	it("fails start with SOCKET_UNAVAILABLE on connect timeout", async () => {
		vi.useFakeTimers();
		try {
			const client = createWakewordClient({
				socketPath: "/tmp/wakeword.sock",
				connectTimeoutMs: 1000,
			});
			const pendingStart = client.start();
			void pendingStart.catch(() => undefined);
			const socket = mocks.getLastSocket();

			await vi.advanceTimersByTimeAsync(1001);

			await expect(pendingStart).rejects.toMatchObject({
				name: "WakewordClientError",
				code: "SOCKET_UNAVAILABLE",
			});
			expect(socket?.destroy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers wakeword detections after ready", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit(
			"data",
			'{"type":"wakeword","timestamp":"2026-02-14T10:00:05.120Z","keyword":"herzen","score":0.82,"threshold":0.5,"model":"herzen_v1"}\n',
		);

		await expect(pendingDetection).resolves.toMatchObject({
			keyword: "herzen",
			score: 0.82,
			threshold: 0.5,
			model: "herzen_v1",
			timestamp: Date.parse("2026-02-14T10:00:05.120Z"),
		});
	});

	it("rejects pending detection with SOURCE_CLOSED on disconnect", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit("close");

		await expect(pendingDetection).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "SOURCE_CLOSED",
		});
	});

	it("maps daemon error message to SOURCE_FAILED", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit(
			"data",
			'{"type":"error","timestamp":"2026-02-14T10:00:10.000Z","code":"MIC_FAILURE","message":"Input failed"}\n',
		);

		await expect(pendingDetection).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "SOURCE_FAILED",
		});
	});

	it("ignores unknown message types", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit("data", '{"type":"metrics","timestamp":"2026-02-14T10:00:01.000Z","value":1}\n');
		socket?.emit(
			"data",
			'{"type":"wakeword","timestamp":"2026-02-14T10:00:05.120Z","keyword":"herzen","score":0.82,"threshold":0.5}\n',
		);

		await expect(pendingDetection).resolves.toMatchObject({
			keyword: "herzen",
		});
	});

	it("treats malformed JSON as PROTOCOL_ERROR and closes the socket", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit("data", "{not-json}\n");

		await expect(pendingDetection).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "PROTOCOL_ERROR",
		});
		expect(socket?.destroy).toHaveBeenCalledTimes(1);
		await expect(client.nextDetection()).rejects.toMatchObject({
			code: "PROTOCOL_ERROR",
		});
	});

	it("rejects invalid ready payload as PROTOCOL_ERROR", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const pendingStart = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready"}\n');

		await expect(pendingStart).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "PROTOCOL_ERROR",
		});
		expect(socket?.destroy).toHaveBeenCalledTimes(1);
	});

	it("rejects wakeword payload with invalid timestamp as PROTOCOL_ERROR", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit(
			"data",
			'{"type":"wakeword","timestamp":"not-a-date","keyword":"herzen","score":0.82,"threshold":0.5}\n',
		);

		await expect(pendingDetection).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "PROTOCOL_ERROR",
		});
	});

	it("fails with PROTOCOL_ERROR when line buffer exceeds max size", async () => {
		const client = createWakewordClient({
			socketPath: "/tmp/wakeword.sock",
			connectTimeoutMs: 1000,
		});
		const start = client.start();

		const socket = mocks.getLastSocket();
		socket?.emit("data", '{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z"}\n');
		await start;

		const pendingDetection = client.nextDetection();
		socket?.emit("data", "x".repeat(70 * 1024));

		await expect(pendingDetection).rejects.toMatchObject({
			name: "WakewordClientError",
			code: "PROTOCOL_ERROR",
		});
		expect(socket?.destroy).toHaveBeenCalledTimes(1);
	});
});

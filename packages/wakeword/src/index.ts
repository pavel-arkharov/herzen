import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WakewordClientErrorCode =
	| "CONFIG_INVALID"
	| "SOCKET_UNAVAILABLE"
	| "PROTOCOL_ERROR"
	| "SOURCE_CLOSED"
	| "SOURCE_FAILED";

export interface WakewordClientErrorOptions {
	cause?: unknown;
}

export class WakewordClientError extends Error {
	readonly code: WakewordClientErrorCode;
	declare readonly cause?: unknown;

	constructor(code: WakewordClientErrorCode, message: string, options?: WakewordClientErrorOptions) {
		super(message);
		this.name = "WakewordClientError";
		this.code = code;
		this.cause = options?.cause;
	}
}

export interface WakewordDetection {
	keyword: string;
	score: number;
	threshold: number;
	model?: string;
	timestamp: number;
	sourceTimestamp: string;
}

export interface WakewordClient {
	start(): Promise<void>;
	nextDetection(): Promise<WakewordDetection>;
	stop(): Promise<void> | void;
}

export interface WakewordClientOptions {
	socketPath?: string;
	dataDir?: string;
	connectTimeoutMs?: number;
}

interface ProtocolBaseMessage {
	type: string;
	timestamp: string;
}

interface ReadyMessage extends ProtocolBaseMessage {
	type: "ready";
}

interface WakewordMessage extends ProtocolBaseMessage {
	type: "wakeword";
	keyword: string;
	score: number;
	threshold: number;
	model?: string;
}

interface ErrorMessage extends ProtocolBaseMessage {
	type: "error";
	code: string;
	message: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const MAX_BUFFER_BYTES = 64 * 1024;
const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

export function resolveWakewordSocketPath(
	rawSocketPath = process.env.HERZEN_WAKEWORD_SOCKET,
	rawDataDir = process.env.HERZEN_DATA_DIR,
): string {
	const trimmedPath = rawSocketPath?.trim();
	if (trimmedPath) {
		return isAbsolute(trimmedPath) ? trimmedPath : resolve(trimmedPath);
	}
	if (rawSocketPath !== undefined) {
		throw new WakewordClientError(
			"CONFIG_INVALID",
			"HERZEN_WAKEWORD_SOCKET must be a non-empty path when provided.",
		);
	}

	const trimmedDataDir = rawDataDir?.trim();
	const dataRoot = trimmedDataDir ? (isAbsolute(trimmedDataDir) ? trimmedDataDir : resolve(trimmedDataDir)) : defaultDataRoot;
	return join(dataRoot, "run", "wakeword.sock");
}

export function resolveWakewordConnectTimeoutMs(
	rawTimeout = process.env.HERZEN_WAKEWORD_CONNECT_TIMEOUT_MS,
): number {
	if (rawTimeout === undefined) return DEFAULT_CONNECT_TIMEOUT_MS;

	const timeoutText = rawTimeout.trim();
	if (!timeoutText) return DEFAULT_CONNECT_TIMEOUT_MS;

	const parsed = Number(timeoutText);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new WakewordClientError(
			"CONFIG_INVALID",
			`Invalid HERZEN_WAKEWORD_CONNECT_TIMEOUT_MS "${rawTimeout}". Expected a positive integer.`,
		);
	}
	return parsed;
}

export function createWakewordClient(options: WakewordClientOptions = {}): WakewordClient {
	const socketPath = resolveWakewordSocketPath(options.socketPath, options.dataDir);
	const connectTimeoutMs = resolveConnectTimeout(options.connectTimeoutMs);
	return new SocketWakewordClient(socketPath, connectTimeoutMs);
}

function resolveConnectTimeout(rawTimeout: number | undefined): number {
	if (rawTimeout === undefined) {
		return resolveWakewordConnectTimeoutMs(process.env.HERZEN_WAKEWORD_CONNECT_TIMEOUT_MS);
	}
	if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
		throw new WakewordClientError("CONFIG_INVALID", "connectTimeoutMs must be a positive integer.");
	}
	return rawTimeout;
}

class SocketWakewordClient implements WakewordClient {
	private socket: Socket | null = null;
	private started = false;
	private ready = false;
	private stopping = false;
	private buffer = "";
	private terminalError: WakewordClientError | null = null;
	private startPromise: Promise<void> | null = null;
	private connectTimer: NodeJS.Timeout | null = null;
	private pendingStartResolve: (() => void) | null = null;
	private pendingStartReject: ((reason?: unknown) => void) | null = null;
	private pendingDetectionResolve: ((detection: WakewordDetection) => void) | null = null;
	private pendingDetectionReject: ((reason?: unknown) => void) | null = null;

	constructor(
		private readonly socketPath: string,
		private readonly connectTimeoutMs: number,
	) {}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		if (this.started && this.ready) return Promise.resolve();

		this.stopping = false;
		this.ready = false;
		this.started = true;
		this.buffer = "";
		this.terminalError = null;

		this.startPromise = new Promise<void>((resolve, reject) => {
			this.pendingStartResolve = resolve;
			this.pendingStartReject = reject;

			let socket: Socket;
			try {
				socket = createConnection({ path: this.socketPath });
			} catch (err) {
				const wrapped = new WakewordClientError(
					"SOCKET_UNAVAILABLE",
					`Failed to connect to wakeword socket at ${this.socketPath}.`,
					{ cause: err },
				);
				this.fail(wrapped);
				return;
			}

			this.socket = socket;
			socket.on("data", this.onSocketData);
			socket.on("error", this.onSocketError);
			socket.on("close", this.onSocketClose);
			this.connectTimer = setTimeout(() => {
				this.fail(
					new WakewordClientError(
						"SOCKET_UNAVAILABLE",
						`Timed out waiting for wakeword daemon readiness after ${this.connectTimeoutMs}ms.`,
					),
					{ closeSocket: true },
				);
			}, this.connectTimeoutMs);
		}).finally(() => {
			this.startPromise = null;
		});

		return this.startPromise;
	}

	async nextDetection(): Promise<WakewordDetection> {
		if (this.terminalError) throw this.terminalError;
		if (!this.started || !this.socket) {
			throw new WakewordClientError("SOURCE_FAILED", "Wakeword client is not started.");
		}
		if (!this.ready) {
			throw new WakewordClientError("SOURCE_FAILED", "Wakeword client is not ready.");
		}
		if (this.pendingDetectionResolve || this.pendingDetectionReject) {
			throw new WakewordClientError("SOURCE_FAILED", "Wakeword client is already awaiting a detection.");
		}

		return new Promise<WakewordDetection>((resolve, reject) => {
			this.pendingDetectionResolve = resolve;
			this.pendingDetectionReject = reject;
		});
	}

	stop() {
		if (!this.started && !this.socket && !this.startPromise) return;

		this.stopping = true;
		this.buffer = "";
		this.started = false;
		this.ready = false;
		const stopError = new WakewordClientError("SOURCE_CLOSED", "Wakeword client stopped.");
		this.terminalError = stopError;
		this.clearConnectTimer();
		this.rejectPendingStart(stopError);
		this.rejectPendingDetection(stopError);

		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.off("data", this.onSocketData);
			socket.off("error", this.onSocketError);
			socket.off("close", this.onSocketClose);
			socket.destroy();
		}
		this.stopping = false;
	}

	private readonly onSocketData = (chunk: Buffer | string) => {
		if (this.terminalError) return;

		this.buffer += chunk.toString();
		if (Buffer.byteLength(this.buffer, "utf8") > MAX_BUFFER_BYTES) {
			this.fail(
				new WakewordClientError(
					"PROTOCOL_ERROR",
					`Wakeword protocol line exceeded ${MAX_BUFFER_BYTES} bytes without newline.`,
				),
				{ closeSocket: true },
			);
			return;
		}
		let lineEnd = this.buffer.indexOf("\n");

		while (lineEnd >= 0) {
			const line = this.buffer.slice(0, lineEnd).trim();
			this.buffer = this.buffer.slice(lineEnd + 1);
			if (line) {
				this.handleProtocolLine(line);
			}

			if (this.terminalError) return;
			lineEnd = this.buffer.indexOf("\n");
		}
	};

	private readonly onSocketError = (err: NodeJS.ErrnoException) => {
		if (this.stopping) return;

		const code = this.ready ? "SOURCE_FAILED" : "SOCKET_UNAVAILABLE";
		const message = this.ready ?
			`Wakeword daemon socket failed: ${err.message}` :
			`Could not connect to wakeword socket at ${this.socketPath}: ${err.message}`;
		this.fail(new WakewordClientError(code, message, { cause: err }), { closeSocket: true });
	};

	private readonly onSocketClose = () => {
		this.clearConnectTimer();
		this.socket = null;
		this.started = false;
		this.ready = false;

		if (this.stopping) {
			this.stopping = false;
			return;
		}

		if (!this.terminalError) {
			this.fail(new WakewordClientError("SOURCE_CLOSED", "Wakeword daemon connection closed."));
			return;
		}

		this.rejectPendingStart(this.terminalError);
		this.rejectPendingDetection(this.terminalError);
	};

	private handleProtocolLine(line: string) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			this.fail(
				new WakewordClientError("PROTOCOL_ERROR", "Received malformed JSON from wakeword daemon.", {
					cause: err,
				}),
				{ closeSocket: true },
			);
			return;
		}

		if (!isProtocolBaseMessage(parsed)) {
			this.fail(
				new WakewordClientError("PROTOCOL_ERROR", "Received invalid wakeword protocol message shape."),
				{ closeSocket: true },
			);
			return;
		}

		switch (parsed.type) {
			case "ready":
				if (!isReadyMessage(parsed)) {
					this.fail(
						new WakewordClientError("PROTOCOL_ERROR", "Received invalid wakeword ready message."),
						{ closeSocket: true },
					);
					return;
				}
				this.ready = true;
				this.clearConnectTimer();
				this.resolvePendingStart();
				return;
			case "wakeword":
				if (!isWakewordMessage(parsed)) {
					this.fail(
						new WakewordClientError("PROTOCOL_ERROR", "Received invalid wakeword detection message."),
						{ closeSocket: true },
					);
					return;
				}
				this.handleDetection(parsed);
				return;
			case "heartbeat":
				return;
			case "error":
				if (!isErrorMessage(parsed)) {
					this.fail(
						new WakewordClientError("PROTOCOL_ERROR", "Received invalid wakeword error message."),
						{ closeSocket: true },
					);
					return;
				}
				this.fail(
					new WakewordClientError(
						"SOURCE_FAILED",
						`Wakeword daemon error (${parsed.code}): ${parsed.message}`,
					),
					{ closeSocket: true },
				);
				return;
			default:
				return;
		}
	}

	private handleDetection(message: WakewordMessage) {
		if (!this.ready) return;
		if (!this.pendingDetectionResolve) return;

		const resolve = this.pendingDetectionResolve;
		this.clearPendingDetection();
		resolve({
			keyword: message.keyword,
			score: message.score,
			threshold: message.threshold,
			model: message.model,
			timestamp: Date.parse(message.timestamp),
			sourceTimestamp: message.timestamp,
		});
	}

	private fail(err: WakewordClientError, options?: { closeSocket?: boolean }) {
		if (!this.terminalError) {
			this.terminalError = err;
		}

		this.started = false;
		this.ready = false;
		this.clearConnectTimer();
		this.rejectPendingStart(this.terminalError);
		this.rejectPendingDetection(this.terminalError);

		if (options?.closeSocket && this.socket) {
			const socket = this.socket;
			this.socket = null;
			socket.off("data", this.onSocketData);
			socket.off("error", this.onSocketError);
			socket.off("close", this.onSocketClose);
			socket.destroy();
		}
	}

	private resolvePendingStart() {
		const resolve = this.pendingStartResolve;
		this.clearPendingStart();
		resolve?.();
	}

	private rejectPendingStart(err: WakewordClientError) {
		const reject = this.pendingStartReject;
		this.clearPendingStart();
		reject?.(err);
	}

	private rejectPendingDetection(err: WakewordClientError) {
		const reject = this.pendingDetectionReject;
		this.clearPendingDetection();
		reject?.(err);
	}

	private clearPendingStart() {
		this.pendingStartResolve = null;
		this.pendingStartReject = null;
	}

	private clearPendingDetection() {
		this.pendingDetectionResolve = null;
		this.pendingDetectionReject = null;
	}

	private clearConnectTimer() {
		if (!this.connectTimer) return;
		clearTimeout(this.connectTimer);
		this.connectTimer = null;
	}
}

function isProtocolBaseMessage(value: unknown): value is ProtocolBaseMessage {
	if (!isObjectRecord(value)) return false;
	return typeof value.type === "string" && typeof value.timestamp === "string";
}

function isReadyMessage(value: ProtocolBaseMessage): value is ReadyMessage {
	return value.type === "ready";
}

function isWakewordMessage(value: ProtocolBaseMessage): value is WakewordMessage {
	if (value.type !== "wakeword") return false;
	if (!isObjectRecord(value)) return false;
	if (typeof value.keyword !== "string") return false;
	if (!Number.isFinite(value.score)) return false;
	if (!Number.isFinite(value.threshold)) return false;
	if (value.model !== undefined && typeof value.model !== "string") return false;
	if (Number.isNaN(Date.parse(value.timestamp))) return false;
	return true;
}

function isErrorMessage(value: ProtocolBaseMessage): value is ErrorMessage {
	if (value.type !== "error") return false;
	if (!isObjectRecord(value)) return false;
	return typeof value.code === "string" && typeof value.message === "string";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

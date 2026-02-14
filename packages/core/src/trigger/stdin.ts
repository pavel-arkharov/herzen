import readline from "node:readline";
import { TriggerError, type TriggerEvent, type TriggerSource } from "./types.js";

export class StdinTriggerSource implements TriggerSource {
	private static readonly MAX_PENDING_EVENTS = 3;

	private rl: readline.Interface | null = null;
	private started = false;
	private queue: TriggerEvent[] = [];
	private pendingReject: ((reason?: unknown) => void) | null = null;
	private pendingResolve: ((event: TriggerEvent) => void) | null = null;
	private terminalError: TriggerError | null = null;

	private readonly onLine = () => {
		const event: TriggerEvent = {
			kind: "manual",
			mode: "stdin",
			timestamp: Date.now(),
		};

		if (this.pendingResolve) {
			const resolve = this.pendingResolve;
			this.clearPending();
			resolve(event);
			return;
		}

		if (this.queue.length >= StdinTriggerSource.MAX_PENDING_EVENTS) {
			return;
		}

		this.queue.push(event);
	};

	private readonly onStdinError = (err: NodeJS.ErrnoException | null) => {
		if (err?.code === "EIO") {
			this.fail(new TriggerError("SOURCE_CLOSED", "Stdin trigger source closed.", { cause: err }));
			return;
		}

		this.fail(
			new TriggerError("SOURCE_FAILED", "Stdin trigger source failed from stdin error.", {
				cause: err ?? undefined,
			}),
		);
	};

	private readonly onInterfaceClose = () => {
		this.fail(new TriggerError("SOURCE_CLOSED", "Stdin trigger source closed."));
	};

	start() {
		if (this.started) return;

		this.terminalError = null;
		this.queue = [];
		this.clearPending();
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		this.rl.on("line", this.onLine);
		this.rl.on("close", this.onInterfaceClose);
		process.stdin.on("error", this.onStdinError);
		this.started = true;
	}

	async nextTrigger(): Promise<TriggerEvent> {
		if (!this.started || !this.rl) {
			throw new TriggerError("SOURCE_FAILED", "Stdin trigger source is not started.");
		}

		if (this.pendingResolve || this.pendingReject) {
			throw new TriggerError("SOURCE_FAILED", "Stdin trigger source is already awaiting a trigger.");
		}

		if (this.terminalError) {
			throw this.terminalError;
		}

		const queued = this.queue.shift();
		if (queued) return queued;

		return new Promise<TriggerEvent>((resolve, reject) => {
			this.pendingResolve = resolve;
			this.pendingReject = reject;
		});
	}

	stop() {
		if (!this.started) return;

		this.started = false;
		const rl = this.rl;
		this.rl = null;
		this.queue = [];
		process.stdin.off("error", this.onStdinError);
		if (rl) {
			rl.off("line", this.onLine);
			rl.off("close", this.onInterfaceClose);
		}
		this.rejectPending(new TriggerError("SOURCE_CLOSED", "Stdin trigger source stopped."));
		rl?.close();
	}

	private fail(err: TriggerError) {
		if (!this.terminalError) {
			this.terminalError = err;
		}
		this.rejectPending(this.terminalError);
	}

	private rejectPending(err: TriggerError) {
		const reject = this.pendingReject;
		this.clearPending();
		reject?.(err);
	}

	private clearPending() {
		this.pendingResolve = null;
		this.pendingReject = null;
	}
}

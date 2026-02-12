import readline from "node:readline";
import { TriggerError, type TriggerEvent, type TriggerSource } from "./types.js";

export class StdinTriggerSource implements TriggerSource {
	private rl: readline.Interface | null = null;
	private started = false;
	private pendingReject: ((reason?: unknown) => void) | null = null;
	private pendingLineHandler: (() => void) | null = null;
	private terminalError: TriggerError | null = null;

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
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		this.rl.on("close", this.onInterfaceClose);
		process.stdin.on("error", this.onStdinError);
		this.started = true;
	}

	async nextTrigger(): Promise<TriggerEvent> {
		if (!this.started || !this.rl) {
			throw new TriggerError("SOURCE_FAILED", "Stdin trigger source is not started.");
		}

		if (this.pendingReject) {
			throw new TriggerError("SOURCE_FAILED", "Stdin trigger source is already awaiting a trigger.");
		}

		if (this.terminalError) {
			throw this.terminalError;
		}

		return new Promise<TriggerEvent>((resolve, reject) => {
			const rl = this.rl;
			if (!rl) {
				reject(new TriggerError("SOURCE_FAILED", "Stdin trigger source is unavailable."));
				return;
			}

			const onLine = () => {
				this.clearPending();
				resolve({
					kind: "manual",
					mode: "stdin",
					timestamp: Date.now(),
				});
			};

			this.pendingReject = reject;
			this.pendingLineHandler = onLine;
			rl.once("line", onLine);
		});
	}

	stop() {
		if (!this.started) return;

		this.started = false;
		const rl = this.rl;
		this.rl = null;
		process.stdin.off("error", this.onStdinError);
		if (rl) {
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
		if (this.rl && this.pendingLineHandler) {
			this.rl.off("line", this.pendingLineHandler);
		}
		this.pendingLineHandler = null;
		this.pendingReject = null;
	}
}

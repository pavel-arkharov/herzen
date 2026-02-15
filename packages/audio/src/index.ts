import { spawn } from "node:child_process";
import { statSync } from "node:fs";

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("error", reject);
		p.on("exit", (code: number | null) =>
			code === 0 ? resolve() : (
				reject(new Error(`${cmd} exited with code ${code}`))
			),
		);
	});
}

export async function recordWav(
	outFile: string,
	seconds: number,
	sampleRate = 16000,
): Promise<void> {
	// Record with device defaults, then resample deterministically for STT.
	await run("rec", [
		"-q",
		"-c",
		"1",
		outFile,
		"trim",
		"0",
		String(seconds),
		"rate",
		"-v",
		String(sampleRate),
	]);
}

export interface AdaptiveRecordOptions {
	maxSeconds: number;
	minSeconds: number;
	silenceSeconds: number;
	silenceThresholdPercent: number;
	noSpeechTimeoutSeconds: number;
	sampleRate?: number;
}

function hasSpeechMeterHit(chunk: Buffer | string, thresholdPercent: number): boolean {
	const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
	for (const match of text.matchAll(/In:\s*([0-9]+(?:\.[0-9]+)?)%/g)) {
		const level = Number.parseFloat(match[1] ?? "");
		if (Number.isFinite(level) && level >= thresholdPercent) return true;
	}
	return false;
}

export async function recordWavAdaptive(outFile: string, options: AdaptiveRecordOptions): Promise<void> {
	const sampleRate = options.sampleRate ?? 16000;
	const meterThreshold = Math.max(options.silenceThresholdPercent, 0.01);
	const maxGuardMs = Math.ceil(options.maxSeconds * 1000) + 1000;
	const speechDataBytesThreshold = 512;
	const noSpeechTimeoutMs = Math.max(0, Math.ceil(options.noSpeechTimeoutSeconds * 1000));

	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"rec",
			[
				"-S",
				"-c",
				"1",
				outFile,
				"silence",
				"1",
				"0.10",
				`${options.silenceThresholdPercent}%`,
				"1",
				String(options.silenceSeconds),
				`${options.silenceThresholdPercent}%`,
				"trim",
				"0",
				String(options.maxSeconds),
				"rate",
				"-v",
				String(sampleRate),
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);

		const startedAt = Date.now();
		let settled = false;
		let speechDetected = false;
		let minSecondsReached = options.minSeconds <= 0;
		let hardKillTimer: NodeJS.Timeout | undefined;
		let speechPoller: NodeJS.Timeout | undefined;
		let noSpeechWatchdog: NodeJS.Timeout | undefined;
		let hasMeterSamples = false;

		const finish = (handler: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(minTimer);
			clearTimeout(maxGuardTimer);
			if (speechPoller) clearInterval(speechPoller);
			if (noSpeechWatchdog) clearInterval(noSpeechWatchdog);
			handler();
		};

		const terminate = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// Ignore secondary shutdown failures.
			}
			hardKillTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignore secondary shutdown failures.
				}
			}, 500);
		};

		const minTimer = setTimeout(() => {
			minSecondsReached = true;
		}, Math.max(0, Math.ceil(options.minSeconds * 1000)));

		const maxGuardTimer = setTimeout(() => {
			terminate();
			finish(() => {
				reject(new Error("Adaptive recording exceeded maximum duration guard."));
			});
		}, Math.max(0, maxGuardMs));

		speechPoller = setInterval(() => {
			if (speechDetected) return;
			try {
				const stats = statSync(outFile);
				if (stats.size <= speechDataBytesThreshold) return;
				speechDetected = true;
			} catch {
				// File may not exist yet while rec is waiting for speech.
			}
		}, 100);

		noSpeechWatchdog = setInterval(() => {
			if (speechDetected) return;
			const elapsedMs = Date.now() - startedAt;
			if (elapsedMs < noSpeechTimeoutMs) return;

			let fileExists = false;
			let hasAudioData = false;
			try {
				const stats = statSync(outFile);
				fileExists = true;
				hasAudioData = stats.size > speechDataBytesThreshold;
			} catch {
				// File may not exist yet while rec is waiting for speech.
			}

			if (hasAudioData) {
				speechDetected = true;
				return;
			}

			// Only enforce timeout when there is affirmative silence evidence.
			if (!hasMeterSamples && !fileExists) return;

			terminate();
			finish(() => {
				reject(new Error("Adaptive recording timed out waiting for speech."));
			});
		}, 100);

		child.stderr?.on("data", (chunk) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (text.includes("In:")) hasMeterSamples = true;
			if (speechDetected) return;
			if (!hasSpeechMeterHit(chunk, meterThreshold)) return;
			speechDetected = true;
		});

		child.on("error", (err) => {
			if (hardKillTimer) {
				clearTimeout(hardKillTimer);
				hardKillTimer = undefined;
			}
			finish(() => reject(err));
		});

		child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			if (hardKillTimer) {
				clearTimeout(hardKillTimer);
				hardKillTimer = undefined;
			}
			if (settled) return;
			if (code === 0) {
				const elapsedSeconds = (Date.now() - startedAt) / 1000;
				if (speechDetected && !minSecondsReached && elapsedSeconds + 0.001 < options.minSeconds) {
					finish(() => {
						reject(new Error(`Adaptive recording ended before minimum ${options.minSeconds.toFixed(1)}s.`));
					});
					return;
				}
				finish(resolve);
				return;
			}

			const reason = signal ? `signal ${signal}` : `code ${code}`;
			finish(() => reject(new Error(`rec exited with ${reason}`)));
		});
	});
}

export async function playAudio(file: string): Promise<void> {
	await run("play", ["-q", file]);
}

export async function beep(): Promise<void> {
	// simple 200ms sine beep
	await run("play", ["-q", "-n", "synth", "0.2", "sine", "880"]);
}

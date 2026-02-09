import { spawn } from "node:child_process";

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
	// mono, 16kHz WAV, record N seconds
	await run("rec", [
		"-c",
		"1",
		"-r",
		String(sampleRate),
		outFile,
		"trim",
		"0",
		String(seconds),
	]);
}

export async function playAudio(file: string): Promise<void> {
	await run("play", [file]);
}

export async function beep(): Promise<void> {
	// simple 200ms sine beep
	await run("play", ["-n", "synth", "0.2", "sine", "880"]);
}

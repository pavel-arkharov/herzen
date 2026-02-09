import { recordWav, playAudio, beep } from "@herzen/audio";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const outDir = join(process.cwd(), "..", "..", "data", "audio");
mkdirSync(outDir, { recursive: true });

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

// Graceful shutdown on Ctrl+C
function shutdown(code = 0) {
	try {
		rl.close();
	} catch (err) {
		void err;
	}
	process.exit(code);
}

process.on("SIGINT", () => {
	console.log("\nShutting down…");
	shutdown(0);
});

// On macOS, Ctrl+C can cause stdin to throw EIO while waiting for input.
// Treat it as a normal shutdown instead of crashing.
process.stdin.on("error", (err: NodeJS.ErrnoException | null) => {
	if (err?.code === "EIO") shutdown(0);
	else console.error("stdin error:", err);
});

rl.on("close", () => shutdown(0));

async function handleTrigger() {
	const file = join(outDir, `test-${Date.now()}.wav`);

	console.log("Triggered. Recording 5 seconds…");
	await beep();
	await recordWav(file, 5);

	console.log("Playing back…");
	await playAudio(file);

	console.log("Done:", file);
}

function listenLoop() {
	console.log("\nListening… (press Enter to trigger)");
	rl.once("line", async () => {
		try {
			await handleTrigger();
		} catch (err) {
			console.error("Error:", err);
		} finally {
			listenLoop(); // go back to idle
		}
	});
}

listenLoop();

import { recordWav, playAudio, beep } from "@herzen/audio";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const outDir = join(process.cwd(), "..", "..", "data", "audio");
  mkdirSync(outDir, { recursive: true });

  const file = join(outDir, `test-${Date.now()}.wav`);

  console.log("Recording 5 seconds…");
  await beep();
  await recordWav(file, 5);

  console.log("Playing back…");
  await playAudio(file);

  console.log("Done:", file);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { spawn } from "node:child_process";

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("error", reject);
		p.on("exit", (code) =>
			code === 0 ? resolve() : (
				reject(new Error(`${cmd} exited with code ${code}`))
			),
		);
	});
}

function hasCyrillic(s: string): boolean {
	return /[А-Яа-яЁё]/.test(s);
}

function parseTaggedLanguage(text: string): {
	lang?: "en" | "ru";
	clean: string;
} {
	const m = text.match(/^\s*\[(en|ru)\]\s*/i);
	if (!m) return { clean: text };
	const lang = m[1].toLowerCase() as "en" | "ru";
	return { lang, clean: text.slice(m[0].length) };
}

// You can tweak these voice names later based on what’s installed on your mac.
function pickVoice(lang: "en" | "ru"): string | undefined {
	// If voice name is undefined, macOS will use its default voice.
	if (lang === "ru") return undefined; // often works fine without specifying
	return undefined;
}

export async function speak(text: string): Promise<void> {
	const { lang, clean } = parseTaggedLanguage(text);
	const finalLang: "en" | "ru" = lang ?? (hasCyrillic(clean) ? "ru" : "en");
	const voice = pickVoice(finalLang);

	const args: string[] = [];
	if (voice) args.push("-v", voice);
	args.push(clean);

	await run("say", args);
}

export async function listVoices(): Promise<void> {
	await run("say", ["-v", "?"]);
}

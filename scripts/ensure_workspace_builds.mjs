#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_DIR_BY_NAME = {
	"@herzen/dialog": "packages/dialog",
	"@herzen/integration-homeassistant": "packages/integration-homeassistant",
	"@herzen/tts": "packages/tts",
};

const requestedPackages = process.argv.slice(2);
const packageNames =
	requestedPackages.length > 0 ?
		requestedPackages
	: ["@herzen/dialog", "@herzen/tts", "@herzen/integration-homeassistant"];

async function main() {
	for (const packageName of packageNames) {
		const packageDirRelative = PACKAGE_DIR_BY_NAME[packageName];
		if (!packageDirRelative) {
			console.error(`[ensure-builds] Unknown workspace package: ${packageName}`);
			process.exitCode = 1;
			return;
		}

		const packageDir = join(rootDir, packageDirRelative);
		const shouldBuild = await isBuildStale(packageDir);

		if (!shouldBuild) {
			console.log(`[ensure-builds] ${packageName}: up to date`);
			continue;
		}

		console.log(`[ensure-builds] ${packageName}: stale, running build`);
		await run("pnpm", ["--filter", packageName, "build"]);
	}
}

async function isBuildStale(packageDir) {
	const srcDir = join(packageDir, "src");
	const distDir = join(packageDir, "dist");
	const configFiles = [join(packageDir, "package.json"), join(packageDir, "tsconfig.json")];

	const sourceMtime = await newestMtimeMs([srcDir, ...configFiles]);
	const distMtime = await newestMtimeMs([distDir]);

	if (sourceMtime === 0) return false;
	if (distMtime === 0) return true;
	return sourceMtime > distMtime;
}

async function newestMtimeMs(paths) {
	let newest = 0;

	for (const path of paths) {
		const pathNewest = await newestMtimeForPath(path);
		if (pathNewest > newest) newest = pathNewest;
	}

	return newest;
}

async function newestMtimeForPath(path) {
	let entryStats;
	try {
		entryStats = await stat(path);
	} catch {
		return 0;
	}

	if (!entryStats.isDirectory()) {
		return entryStats.mtimeMs;
	}

	let newest = entryStats.mtimeMs;
	const queue = [path];

	while (queue.length > 0) {
		const currentDir = queue.shift();
		if (!currentDir) continue;

		const entries = await readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			const stats = await stat(fullPath);
			if (stats.mtimeMs > newest) newest = stats.mtimeMs;
			if (entry.isDirectory()) queue.push(fullPath);
		}
	}

	return newest;
}

function run(command, args) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			cwd: rootDir,
		});

		child.on("error", rejectPromise);
		child.on("exit", (code) => {
			if (code === 0) {
				resolvePromise();
				return;
			}

			rejectPromise(new Error(`${command} ${args.join(" ")} failed with code ${String(code)}`));
		});
	});
}

main().catch((err) => {
	console.error("[ensure-builds] Failed:", err);
	process.exitCode = 1;
});

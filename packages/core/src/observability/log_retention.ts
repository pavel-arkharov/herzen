import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveSettings } from "../settings/registry.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LogRetentionPolicy {
	enabled: boolean;
	maxBytes: number;
	maxAgeDays: number;
	pruneOnStartup: boolean;
}

interface LogFile {
	path: string;
	size: number;
	mtimeMs: number;
}

export interface LogPruneResult {
	enabled: boolean;
	scannedFiles: number;
	removedFiles: string[];
	totalBytesBefore: number;
	totalBytesAfter: number;
}

export function resolveLogRetentionPolicy(env: NodeJS.ProcessEnv = process.env): LogRetentionPolicy {
	const settings = resolveSettings(env).logging;
	return {
		enabled: settings.retentionEnabled,
		maxBytes: settings.retentionMaxBytes,
		maxAgeDays: settings.retentionMaxAgeDays,
		pruneOnStartup: settings.retentionPruneOnStartup,
	};
}

export async function pruneLogDirectory(
	logsDir: string,
	policy: Pick<LogRetentionPolicy, "enabled" | "maxBytes" | "maxAgeDays">,
	options: { nowMs?: () => number } = {},
): Promise<LogPruneResult> {
	if (!policy.enabled) {
		return {
			enabled: false,
			scannedFiles: 0,
			removedFiles: [],
			totalBytesBefore: 0,
			totalBytesAfter: 0,
		};
	}

	const nowMs = options.nowMs ?? (() => Date.now());
	const entries = await readdir(logsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
		if (err.code === "ENOENT") return [];
		throw err;
	});
	const files: LogFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".jsonl")) continue;
		const filePath = join(logsDir, entry.name);
		const fileStat = await stat(filePath).catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return null;
			throw err;
		});
		if (!fileStat) continue;
		files.push({
			path: filePath,
			size: fileStat.size,
			mtimeMs: fileStat.mtimeMs,
		});
	}

	const totalBytesBefore = files.reduce((sum, file) => sum + file.size, 0);
	const removedFiles: string[] = [];
	const maxAgeMs = Math.max(0, policy.maxAgeDays) * DAY_MS;
	const oldestAllowedMtime = nowMs() - maxAgeMs;
	const survivors: LogFile[] = [];

	for (const file of files) {
		if (file.mtimeMs >= oldestAllowedMtime) {
			survivors.push(file);
			continue;
		}
		if (await removeFileBestEffort(file.path)) {
			removedFiles.push(file.path);
			continue;
		}
		survivors.push(file);
	}

	survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
	let runningSize = survivors.reduce((sum, file) => sum + file.size, 0);
	let index = 0;
	while (runningSize > policy.maxBytes && index < survivors.length) {
		const candidate = survivors[index];
		if (!candidate) break;
		if (await removeFileBestEffort(candidate.path)) {
			removedFiles.push(candidate.path);
			runningSize -= candidate.size;
		}
		index += 1;
	}

	return {
		enabled: true,
		scannedFiles: files.length,
		removedFiles,
		totalBytesBefore,
		totalBytesAfter: Math.max(0, runningSize),
	};
}

async function removeFileBestEffort(filePath: string): Promise<boolean> {
	try {
		await rm(filePath, { force: true });
		return true;
	} catch {
		return false;
	}
}

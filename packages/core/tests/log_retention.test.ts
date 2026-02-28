import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneLogDirectory, resolveLogRetentionPolicy } from "../src/observability/log_retention.js";

describe("log retention", () => {
	it("prunes by age first, then by total size", async () => {
		const logsDir = await mkdtemp(join(tmpdir(), "herzen-log-retention-"));
		const now = Date.UTC(2026, 1, 27, 12, 0, 0);
		const oldFile = join(logsDir, "old.jsonl");
		const midFile = join(logsDir, "mid.jsonl");
		const newFile = join(logsDir, "new.jsonl");

		try {
			await writeFile(oldFile, `${"a".repeat(20)}\n`, "utf8");
			await writeFile(midFile, `${"b".repeat(40)}\n`, "utf8");
			await writeFile(newFile, `${"c".repeat(40)}\n`, "utf8");

			await utimes(oldFile, new Date(now - 10 * 24 * 60 * 60 * 1000), new Date(now - 10 * 24 * 60 * 60 * 1000));
			await utimes(midFile, new Date(now - 1 * 24 * 60 * 60 * 1000), new Date(now - 1 * 24 * 60 * 60 * 1000));
			await utimes(newFile, new Date(now), new Date(now));

			const result = await pruneLogDirectory(
				logsDir,
				{
					enabled: true,
					maxBytes: 60,
					maxAgeDays: 3,
				},
				{ nowMs: () => now },
			);

			expect(result.removedFiles).toEqual(expect.arrayContaining([oldFile, midFile]));
			const survivor = await readFile(newFile, "utf8");
			expect(survivor).toContain("c");
		} finally {
			await rm(logsDir, { recursive: true, force: true });
		}
	});

	it("handles missing logs directory without throwing", async () => {
		const result = await pruneLogDirectory(join(tmpdir(), "herzen-no-such-logs"), {
			enabled: true,
			maxBytes: 1024,
			maxAgeDays: 7,
		});

		expect(result).toEqual({
			enabled: true,
			scannedFiles: 0,
			removedFiles: [],
			totalBytesBefore: 0,
			totalBytesAfter: 0,
		});
	});

	it("resolves policy from settings registry values", () => {
		const policy = resolveLogRetentionPolicy({
			HERZEN_LOG_RETENTION_ENABLED: "1",
			HERZEN_LOG_RETENTION_MAX_BYTES: "1234",
			HERZEN_LOG_RETENTION_MAX_DAYS: "2",
			HERZEN_LOG_RETENTION_PRUNE_ON_STARTUP: "0",
		});

		expect(policy).toEqual({
			enabled: true,
			maxBytes: 1234,
			maxAgeDays: 2,
			pruneOnStartup: false,
		});
	});
});

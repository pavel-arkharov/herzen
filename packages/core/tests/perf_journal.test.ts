import { describe, expect, it, vi } from "vitest";
import { createPerfJournal, createProcessSampleCollector } from "../src/observability/perf_journal.js";

describe("createPerfJournal", () => {
	it("writes phase and process sample events to perf stream", async () => {
		const writes: Array<{ streamName: string; entry: unknown }> = [];
		const journal = createPerfJournal({
			writer: {
				appendJsonl: vi.fn(async (streamName: string, entry: unknown) => {
					writes.push({ streamName, entry });
				}),
			},
			sessionId: "session-1",
			nowIso: () => "2026-02-24T12:00:00.000Z",
		});

		await journal.recordPhase({
			phase: "stt",
			status: "ok",
			turn: 2,
			mode: "trigger",
			durationMs: 420,
			fields: { transcriptChars: 18 },
		});
		await journal.recordProcessSample({
			rssBytes: 10,
			heapTotalBytes: 20,
			heapUsedBytes: 8,
			externalBytes: 1,
			arrayBuffersBytes: 1,
			processCpuPercent: 11,
			processCpuPercentOfSystem: 2,
			load1: 0.1,
			load5: 0.2,
			load15: 0.3,
			uptimeSec: 5,
			cpuCount: 8,
		});

		expect(writes).toHaveLength(2);
		expect(writes[0]).toMatchObject({
			streamName: "perf",
			entry: {
				schemaVersion: "perf.v1",
				type: "phase",
				ts: "2026-02-24T12:00:00.000Z",
				sessionId: "session-1",
				phase: "stt",
				status: "ok",
				turn: 2,
				mode: "trigger",
				durationMs: 420,
				fields: { transcriptChars: 18 },
			},
		});
		expect(writes[1]).toMatchObject({
			streamName: "perf",
			entry: {
				schemaVersion: "perf.v1",
				type: "process_sample",
				phase: "runtime",
				status: "ok",
				mode: "runtime",
				sessionId: "session-1",
			},
		});
	});

	it("can be disabled by flag", async () => {
		const appendJsonl = vi.fn(async () => {});
		const journal = createPerfJournal({
			writer: { appendJsonl },
			sessionId: "session-2",
			enabled: "0",
		});

		await journal.recordPhase({
			phase: "turn",
			status: "started",
			mode: "trigger",
			turn: 1,
		});

		expect(journal.enabled).toBe(false);
		expect(appendJsonl).not.toHaveBeenCalled();
	});
});

describe("createProcessSampleCollector", () => {
	it("computes process cpu and memory metrics from deltas", () => {
		const hrValues = [0n, 1_000_000_000n];
		const cpuValues = [
			{ user: 0, system: 0 },
			{ user: 200_000, system: 100_000 },
		];
		let hrIndex = 0;
		let cpuIndex = 0;
		const collect = createProcessSampleCollector({
			nowHrTimeNs: () => hrValues[Math.min(hrIndex++, hrValues.length - 1)] ?? 0n,
			cpuUsage: () => cpuValues[Math.min(cpuIndex++, cpuValues.length - 1)] ?? { user: 0, system: 0 },
			memoryUsage: () => ({
				rss: 1_000_000,
				heapTotal: 500_000,
				heapUsed: 300_000,
				external: 25_000,
				arrayBuffers: 10_000,
			}),
			uptimeSeconds: () => 12.5,
			loadAverage: () => [0.8, 0.6, 0.4],
			cpuCount: () => 8,
		});

		const sample = collect();

		expect(sample.processCpuPercent).toBeCloseTo(30, 5);
		expect(sample.processCpuPercentOfSystem).toBeCloseTo(3.75, 5);
		expect(sample.rssBytes).toBe(1_000_000);
		expect(sample.heapUsedBytes).toBe(300_000);
		expect(sample.uptimeSec).toBe(12.5);
		expect(sample.cpuCount).toBe(8);
	});
});

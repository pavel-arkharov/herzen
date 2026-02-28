import { describe, expect, it } from "vitest";
import { createLaneScheduler } from "../src/control/lanes.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

describe("lane scheduler", () => {
	it("preserves FIFO ordering per lane", async () => {
		const scheduler = createLaneScheduler({ maxGlobalConcurrency: 3 });
		const events: string[] = [];

		const first = scheduler.submit("session:a:trigger", async () => {
			events.push("first:start");
			await sleep(20);
			events.push("first:end");
			return "first";
		});
		const second = scheduler.submit("session:a:trigger", async () => {
			events.push("second:start");
			await sleep(5);
			events.push("second:end");
			return "second";
		});

		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
		expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("enforces global concurrency across lanes", async () => {
		let running = 0;
		let maxRunning = 0;
		const scheduler = createLaneScheduler({ maxGlobalConcurrency: 2 });
		const task = async () => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await sleep(15);
			running -= 1;
		};

		await Promise.all([
			scheduler.submit("lane:a", task),
			scheduler.submit("lane:b", task),
			scheduler.submit("lane:c", task),
		]);

		expect(maxRunning).toBe(2);
	});

	it("emits queue depth and wait metrics when jobs start", async () => {
		const metrics: Array<{ laneKey: string; queueDepth: number; waitMs: number }> = [];
		const scheduler = createLaneScheduler({
			maxGlobalConcurrency: 1,
			onMetric: (event) => {
				metrics.push({
					laneKey: event.laneKey,
					queueDepth: event.queueDepth,
					waitMs: event.waitMs,
				});
			},
		});

		await Promise.all([
			scheduler.submit("lane:one", async () => {
				await sleep(10);
			}),
			scheduler.submit("lane:one", async () => {
				await sleep(1);
			}),
		]);

		expect(metrics).toHaveLength(2);
		expect(metrics[0]?.laneKey).toBe("lane:one");
		expect(metrics[1]?.waitMs).toBeGreaterThanOrEqual(0);
	});
});

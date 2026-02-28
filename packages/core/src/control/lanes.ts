export interface LaneMetricEvent {
	laneKey: string;
	queueDepth: number;
	waitMs: number;
	ts: number;
}

export interface LaneSchedulerOptions {
	maxGlobalConcurrency: number;
	nowMs?: () => number;
	onMetric?: (event: LaneMetricEvent) => void;
}

interface LaneJob<T> {
	laneKey: string;
	enqueuedAtMs: number;
	task: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

export interface LaneScheduler {
	submit: <T>(laneKey: string, task: () => Promise<T>) => Promise<T>;
	getQueueDepth: (laneKey?: string) => number;
}

export function createLaneScheduler(options: LaneSchedulerOptions): LaneScheduler {
	const maxGlobalConcurrency = Math.max(1, Math.floor(options.maxGlobalConcurrency));
	const nowMs = options.nowMs ?? (() => Date.now());
	const laneQueues = new Map<string, Array<LaneJob<unknown>>>();
	const laneOrder: string[] = [];
	const runningLanes = new Set<string>();
	let runningGlobal = 0;
	let scheduleCursor = 0;

	const submit = <T>(laneKey: string, task: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const normalizedLaneKey = laneKey.trim();
			const queue = laneQueues.get(normalizedLaneKey);
			const job: LaneJob<T> = {
				laneKey: normalizedLaneKey,
				enqueuedAtMs: nowMs(),
				task,
				resolve,
				reject,
			};

			if (queue) {
				queue.push(job as LaneJob<unknown>);
			} else {
				laneQueues.set(normalizedLaneKey, [job as LaneJob<unknown>]);
				laneOrder.push(normalizedLaneKey);
			}

			drain();
		});

	const getQueueDepth = (laneKey?: string): number => {
		if (laneKey) {
			return laneQueues.get(laneKey)?.length ?? 0;
		}
		let depth = 0;
		for (const queue of laneQueues.values()) {
			depth += queue.length;
		}
		return depth;
	};

	const drain = (): void => {
		while (runningGlobal < maxGlobalConcurrency) {
			const nextJob = dequeueNextRunnableJob();
			if (!nextJob) return;
			startJob(nextJob);
		}
	};

	const dequeueNextRunnableJob = (): LaneJob<unknown> | null => {
		if (laneOrder.length === 0) return null;
		for (let offset = 0; offset < laneOrder.length; offset += 1) {
			const laneIndex = (scheduleCursor + offset) % laneOrder.length;
			const laneKey = laneOrder[laneIndex];
			if (!laneKey || runningLanes.has(laneKey)) continue;
			const queue = laneQueues.get(laneKey);
			if (!queue || queue.length === 0) continue;
			const job = queue.shift();
			if (!job) continue;
			if (queue.length === 0) {
				laneQueues.delete(laneKey);
				laneOrder.splice(laneIndex, 1);
				if (laneOrder.length === 0) {
					scheduleCursor = 0;
				} else {
					scheduleCursor = laneIndex % laneOrder.length;
				}
			} else {
				scheduleCursor = (laneIndex + 1) % laneOrder.length;
			}
			return job;
		}
		return null;
	};

	const startJob = (job: LaneJob<unknown>): void => {
		runningGlobal += 1;
		runningLanes.add(job.laneKey);
		const startedAtMs = nowMs();
		options.onMetric?.({
			laneKey: job.laneKey,
			queueDepth: getQueueDepth(job.laneKey),
			waitMs: Math.max(0, startedAtMs - job.enqueuedAtMs),
			ts: startedAtMs,
		});

		void job
			.task()
			.then(job.resolve, job.reject)
			.finally(() => {
				runningGlobal -= 1;
				runningLanes.delete(job.laneKey);
				drain();
			});
	};

	return {
		submit,
		getQueueDepth,
	};
}

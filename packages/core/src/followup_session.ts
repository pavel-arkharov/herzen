import type { FollowupConfig } from "./followup_config.js";
import type { RunSttTurnOptions, TurnOutcome } from "./turn.js";

const MIN_FOLLOWUP_TURN_WINDOW_MS = 250;

export type FollowupCloseReason = "timeout" | "no_speech" | "stop_phrase" | "max_turns" | "error";

export interface FollowupSessionResult {
	opened: boolean;
	closeReason?: FollowupCloseReason;
	executedTurns: number;
	lastTurn: number;
}

export interface FollowupWindowOpenedEvent {
	windowSeconds: number;
	maxTurns: number;
	openedAtMs: number;
}

export interface FollowupTurnStartedEvent {
	index: number;
	remainingWindowMs: number;
}

export interface FollowupTurnCompletedEvent {
	index: number;
	outcome: TurnOutcome;
}

export interface FollowupWindowClosedEvent {
	reason: FollowupCloseReason;
	executedTurns: number;
	lastTurn: number;
}

export interface FollowupSessionCallbacks {
	onWindowOpened?: (event: FollowupWindowOpenedEvent) => Promise<void> | void;
	onTurnStarted?: (event: FollowupTurnStartedEvent) => Promise<void> | void;
	onTurnCompleted?: (event: FollowupTurnCompletedEvent) => Promise<void> | void;
	onWindowClosed?: (event: FollowupWindowClosedEvent) => Promise<void> | void;
}

export interface RunFollowupSessionOptions {
	initialTurn: TurnOutcome;
	config: FollowupConfig;
	nowMs: () => number;
	runTurn: (options: RunSttTurnOptions) => Promise<TurnOutcome>;
	isStopPhrase: (transcript: string) => boolean;
	callbacks?: FollowupSessionCallbacks;
}

export async function runFollowupSession(
	options: RunFollowupSessionOptions,
): Promise<FollowupSessionResult> {
	const { config, initialTurn } = options;
	if (!config.enabled || !initialTurn.hasTranscript) {
		return {
			opened: false,
			executedTurns: 0,
			lastTurn: initialTurn.turn,
		};
	}

	const callbacks = options.callbacks ?? {};
	const openedAtMs = options.nowMs();
	const windowMs = Math.round(config.windowSeconds * 1000);
	let deadlineMs = openedAtMs + windowMs;

	await callbacks.onWindowOpened?.({
		windowSeconds: config.windowSeconds,
		maxTurns: config.maxTurns,
		openedAtMs,
	});

	let executedTurns = 0;
	let lastTurn = initialTurn.turn;

	const close = async (reason: FollowupCloseReason): Promise<FollowupSessionResult> => {
		await callbacks.onWindowClosed?.({
			reason,
			executedTurns,
			lastTurn,
		});
		return {
			opened: true,
			closeReason: reason,
			executedTurns,
			lastTurn,
		};
	};

	while (executedTurns < config.maxTurns) {
		const remainingWindowMs = deadlineMs - options.nowMs();
		if (remainingWindowMs <= MIN_FOLLOWUP_TURN_WINDOW_MS) {
			return close("timeout");
		}

		const index = executedTurns + 1;
		await callbacks.onTurnStarted?.({
			index,
			remainingWindowMs,
		});

		let outcome: TurnOutcome;
		try {
			outcome = await options.runTurn({
				mode: "followup",
				remainingWindowMs,
				suppressNoSpeechFallback: true,
			});
		} catch {
			return close("error");
		}

		executedTurns = index;
		lastTurn = outcome.turn;
		await callbacks.onTurnCompleted?.({
			index,
			outcome,
		});

		if (!outcome.hasTranscript) {
			return close("no_speech");
		}

		if (outcome.transcript && options.isStopPhrase(outcome.transcript)) {
			return close("stop_phrase");
		}

		// Refresh the follow-up timeout budget after each successful turn.
		deadlineMs = options.nowMs() + windowMs;
	}

	return close("max_turns");
}

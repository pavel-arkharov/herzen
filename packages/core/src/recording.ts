export type RecordMode = "fixed" | "adaptive";

export interface FixedRecordPlan {
	mode: "fixed";
	seconds: number;
}

export interface AdaptiveRecordPlan {
	mode: "adaptive";
	maxSeconds: number;
	minSeconds: number;
	silenceSeconds: number;
	silenceThresholdPercent: number;
	noSpeechTimeoutSeconds: number;
	fallbackSeconds: number;
}

export type RecordPlan = FixedRecordPlan | AdaptiveRecordPlan;

export interface RecordPlanWarningSink {
	warn: (message: string) => void;
}

export const DEFAULT_FIXED_RECORD_SECONDS = 3;
export const SAFE_FALLBACK_RECORD_SECONDS = DEFAULT_FIXED_RECORD_SECONDS;

const RECORD_SECONDS_LIMITS = { min: 0.2, max: 30 };
const ADAPTIVE_MAX_SECONDS_LIMITS = { min: 1, max: 30 };
const ADAPTIVE_MIN_SECONDS_LIMITS = { min: 0.2, max: 15 };
const ADAPTIVE_SILENCE_SECONDS_LIMITS = { min: 0.2, max: 5 };
const ADAPTIVE_THRESHOLD_PERCENT_LIMITS = { min: 0.1, max: 20 };
const ADAPTIVE_NO_SPEECH_TIMEOUT_LIMITS = { min: 0.5, max: 10 };

const ADAPTIVE_DEFAULTS = {
	maxSeconds: 10,
	minSeconds: 1,
	silenceSeconds: 0.8,
	silenceThresholdPercent: 1,
	noSpeechTimeoutSeconds: 2.5,
};

interface ParsedNumber {
	value: number;
	invalid: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function parseBoundedNumber(
	rawValue: string | undefined,
	defaultValue: number,
	limits: { min: number; max: number },
): ParsedNumber {
	const trimmed = rawValue?.trim();
	if (!trimmed) return { value: defaultValue, invalid: false };

	const parsed = Number.parseFloat(trimmed);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return { value: defaultValue, invalid: true };
	}

	return {
		value: clamp(parsed, limits.min, limits.max),
		invalid: false,
	};
}

function resolveFixedRecordSeconds(rawSeconds: string | undefined, warningSink: RecordPlanWarningSink): number {
	const parsed = parseBoundedNumber(rawSeconds, DEFAULT_FIXED_RECORD_SECONDS, RECORD_SECONDS_LIMITS);
	if (!parsed.invalid) return parsed.value;

	warningSink.warn(
		`Invalid HERZEN_RECORD_SECONDS "${rawSeconds}". Falling back to ${DEFAULT_FIXED_RECORD_SECONDS.toFixed(1)} seconds.`,
	);
	return DEFAULT_FIXED_RECORD_SECONDS;
}

function fallbackToFixedWithWarning(warningSink: RecordPlanWarningSink, reason: string): FixedRecordPlan {
	warningSink.warn(
		`Invalid adaptive recording config (${reason}). Falling back to fixed ${DEFAULT_FIXED_RECORD_SECONDS.toFixed(1)} seconds.`,
	);
	return { mode: "fixed", seconds: DEFAULT_FIXED_RECORD_SECONDS };
}

export function resolveRecordPlan(
	env: NodeJS.ProcessEnv,
	warningSink: RecordPlanWarningSink,
): RecordPlan {
	const rawMode = env.HERZEN_RECORD_MODE?.trim().toLowerCase();
	if (!rawMode || rawMode === "fixed") {
		return {
			mode: "fixed",
			seconds: resolveFixedRecordSeconds(env.HERZEN_RECORD_SECONDS, warningSink),
		};
	}

	if (rawMode !== "adaptive") {
		warningSink.warn(
			`Invalid HERZEN_RECORD_MODE "${env.HERZEN_RECORD_MODE}". Falling back to fixed ${DEFAULT_FIXED_RECORD_SECONDS.toFixed(1)} seconds.`,
		);
		return {
			mode: "fixed",
			seconds: DEFAULT_FIXED_RECORD_SECONDS,
		};
	}

	const maxSeconds = parseBoundedNumber(
		env.HERZEN_RECORD_MAX_SECONDS,
		ADAPTIVE_DEFAULTS.maxSeconds,
		ADAPTIVE_MAX_SECONDS_LIMITS,
	);
	const minSeconds = parseBoundedNumber(
		env.HERZEN_RECORD_MIN_SECONDS,
		ADAPTIVE_DEFAULTS.minSeconds,
		ADAPTIVE_MIN_SECONDS_LIMITS,
	);
	const silenceSeconds = parseBoundedNumber(
		env.HERZEN_RECORD_SILENCE_SECONDS,
		ADAPTIVE_DEFAULTS.silenceSeconds,
		ADAPTIVE_SILENCE_SECONDS_LIMITS,
	);
	const silenceThresholdPercent = parseBoundedNumber(
		env.HERZEN_RECORD_SILENCE_THRESHOLD,
		ADAPTIVE_DEFAULTS.silenceThresholdPercent,
		ADAPTIVE_THRESHOLD_PERCENT_LIMITS,
	);
	const noSpeechTimeoutSeconds = parseBoundedNumber(
		env.HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS,
		ADAPTIVE_DEFAULTS.noSpeechTimeoutSeconds,
		ADAPTIVE_NO_SPEECH_TIMEOUT_LIMITS,
	);

	if (maxSeconds.invalid) return fallbackToFixedWithWarning(warningSink, "HERZEN_RECORD_MAX_SECONDS");
	if (minSeconds.invalid) return fallbackToFixedWithWarning(warningSink, "HERZEN_RECORD_MIN_SECONDS");
	if (silenceSeconds.invalid) return fallbackToFixedWithWarning(warningSink, "HERZEN_RECORD_SILENCE_SECONDS");
	if (silenceThresholdPercent.invalid) {
		return fallbackToFixedWithWarning(warningSink, "HERZEN_RECORD_SILENCE_THRESHOLD");
	}
	if (noSpeechTimeoutSeconds.invalid) {
		return fallbackToFixedWithWarning(warningSink, "HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS");
	}

	if (minSeconds.value >= maxSeconds.value) {
		return fallbackToFixedWithWarning(warningSink, "HERZEN_RECORD_MIN_SECONDS >= HERZEN_RECORD_MAX_SECONDS");
	}
	if (noSpeechTimeoutSeconds.value >= maxSeconds.value) {
		return fallbackToFixedWithWarning(
			warningSink,
			"HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS >= HERZEN_RECORD_MAX_SECONDS",
		);
	}

	return {
		mode: "adaptive",
		maxSeconds: maxSeconds.value,
		minSeconds: minSeconds.value,
		silenceSeconds: silenceSeconds.value,
		silenceThresholdPercent: silenceThresholdPercent.value,
		noSpeechTimeoutSeconds: noSpeechTimeoutSeconds.value,
		fallbackSeconds: SAFE_FALLBACK_RECORD_SECONDS,
	};
}

export function formatRecordStartLabel(plan: RecordPlan): string {
	if (plan.mode === "fixed") return `Recording ${plan.seconds.toFixed(1)} seconds…`;
	return `Recording (adaptive, max ${plan.maxSeconds.toFixed(1)}s)…`;
}

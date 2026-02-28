export interface ContextBudget {
	totalChars: number;
	kernelChars: number;
	summaryChars: number;
	recentTurnsChars: number;
	memoryChars: number;
	currentInputReserveChars: number;
}

export interface ContextBudgetLogger {
	warn: (...args: unknown[]) => void;
}

const DEFAULT_BUDGET: ContextBudget = {
	totalChars: 6_000,
	kernelChars: 900,
	summaryChars: 1_000,
	recentTurnsChars: 2_200,
	memoryChars: 1_400,
	currentInputReserveChars: 500,
};

export function resolveContextBudget(
	env: NodeJS.ProcessEnv = process.env,
	logger?: ContextBudgetLogger,
): ContextBudget {
	const totalChars = resolvePositiveInteger(
		env.HERZEN_CONTEXT_BUDGET_TOTAL_CHARS,
		DEFAULT_BUDGET.totalChars,
		"HERZEN_CONTEXT_BUDGET_TOTAL_CHARS",
		logger,
	);

	const budget: ContextBudget = {
		totalChars,
		kernelChars: resolvePositiveInteger(
			env.HERZEN_CONTEXT_BUDGET_KERNEL_CHARS,
			DEFAULT_BUDGET.kernelChars,
			"HERZEN_CONTEXT_BUDGET_KERNEL_CHARS",
			logger,
		),
		summaryChars: resolvePositiveInteger(
			env.HERZEN_CONTEXT_BUDGET_SUMMARY_CHARS,
			DEFAULT_BUDGET.summaryChars,
			"HERZEN_CONTEXT_BUDGET_SUMMARY_CHARS",
			logger,
		),
		recentTurnsChars: resolvePositiveInteger(
			env.HERZEN_CONTEXT_BUDGET_RECENT_TURNS_CHARS,
			DEFAULT_BUDGET.recentTurnsChars,
			"HERZEN_CONTEXT_BUDGET_RECENT_TURNS_CHARS",
			logger,
		),
		memoryChars: resolvePositiveInteger(
			env.HERZEN_CONTEXT_BUDGET_MEMORY_CHARS,
			DEFAULT_BUDGET.memoryChars,
			"HERZEN_CONTEXT_BUDGET_MEMORY_CHARS",
			logger,
		),
		currentInputReserveChars: resolvePositiveInteger(
			env.HERZEN_CONTEXT_BUDGET_CURRENT_INPUT_CHARS,
			DEFAULT_BUDGET.currentInputReserveChars,
			"HERZEN_CONTEXT_BUDGET_CURRENT_INPUT_CHARS",
			logger,
		),
	};

	const sliceTotal =
		budget.kernelChars +
		budget.summaryChars +
		budget.recentTurnsChars +
		budget.memoryChars +
		budget.currentInputReserveChars;
	if (sliceTotal > budget.totalChars) {
		logger?.warn(
			`Context slice budgets (${sliceTotal}) exceed total budget (${budget.totalChars}); excess will be trimmed at assembly time.`,
		);
	}

	return budget;
}

export function trimToCharBudget(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}

function resolvePositiveInteger(
	rawValue: string | undefined,
	fallback: number,
	envName: string,
	logger?: ContextBudgetLogger,
): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	if (!/^\d+$/u.test(trimmed)) {
		logger?.warn(`Invalid ${envName} "${rawValue}". Falling back to ${fallback}.`);
		return fallback;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (Number.isInteger(parsed) && parsed > 0) return parsed;
	logger?.warn(`Invalid ${envName} "${rawValue}". Falling back to ${fallback}.`);
	return fallback;
}

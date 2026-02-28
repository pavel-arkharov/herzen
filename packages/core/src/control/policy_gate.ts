export type PolicyDecisionCode = "POLICY_SCOPE_DENIED" | "IDEMPOTENCY_REPLAY";

export interface PolicyDecision {
	ok: boolean;
	code?: PolicyDecisionCode;
	message?: string;
}

export interface PolicyGate {
	authorize: (input: {
		scope: string;
		idempotencyKey: string;
	}) => PolicyDecision;
}

export interface CreatePolicyGateOptions {
	allowedScopes: string[];
	idempotencyTtlMs?: number;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60_000;

export function createPolicyGate(options: CreatePolicyGateOptions): PolicyGate {
	const allowedScopes = new Set(options.allowedScopes.filter((value) => value.trim().length > 0));
	const idempotencyTtlMs =
		Number.isFinite(options.idempotencyTtlMs) && (options.idempotencyTtlMs ?? 0) > 0
			? Math.floor(options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS)
			: DEFAULT_IDEMPOTENCY_TTL_MS;
	const seenIdempotencyKeys = new Map<string, number>();

	const pruneExpired = (now: number): void => {
		for (const [key, seenAt] of seenIdempotencyKeys.entries()) {
			if (now - seenAt <= idempotencyTtlMs) continue;
			seenIdempotencyKeys.delete(key);
		}
	};

	return {
		authorize: ({ scope, idempotencyKey }) => {
			const now = Date.now();
			pruneExpired(now);

			if (!allowedScopes.has(scope)) {
				return {
					ok: false,
					code: "POLICY_SCOPE_DENIED",
					message: `Scope "${scope}" is not allowlisted.`,
				};
			}

			if (seenIdempotencyKeys.has(idempotencyKey)) {
				return {
					ok: false,
					code: "IDEMPOTENCY_REPLAY",
					message: "Duplicate idempotency key was rejected.",
				};
			}

			seenIdempotencyKeys.set(idempotencyKey, now);
			return { ok: true };
		},
	};
}

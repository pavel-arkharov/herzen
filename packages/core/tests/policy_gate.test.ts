import { describe, expect, it, vi } from "vitest";
import { createPolicyGate } from "../src/control/policy_gate.js";

describe("policy gate", () => {
	it("allows configured scopes and rejects unknown scopes", () => {
		const gate = createPolicyGate({
			allowedScopes: ["ha:write"],
		});

		expect(
			gate.authorize({
				scope: "ha:write",
				idempotencyKey: "k1",
			}),
		).toEqual({ ok: true });

		expect(
			gate.authorize({
				scope: "ha:read",
				idempotencyKey: "k2",
			}),
		).toEqual({
			ok: false,
			code: "POLICY_SCOPE_DENIED",
			message: 'Scope "ha:read" is not allowlisted.',
		});
	});

	it("rejects duplicate idempotency keys within ttl", () => {
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(1_000);
		const gate = createPolicyGate({
			allowedScopes: ["ha:write"],
			idempotencyTtlMs: 5_000,
		});

		expect(
			gate.authorize({
				scope: "ha:write",
				idempotencyKey: "dup-key",
			}),
		).toEqual({ ok: true });

		nowSpy.mockReturnValue(2_000);
		expect(
			gate.authorize({
				scope: "ha:write",
				idempotencyKey: "dup-key",
			}),
		).toEqual({
			ok: false,
			code: "IDEMPOTENCY_REPLAY",
			message: "Duplicate idempotency key was rejected.",
		});

		nowSpy.mockRestore();
	});
});

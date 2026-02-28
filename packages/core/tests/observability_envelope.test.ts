import { describe, expect, it } from "vitest";
import {
	createObservabilityEventEnvelope,
	isObservabilityEventEnvelope,
} from "../src/observability/envelope.js";

describe("observability envelope", () => {
	it("creates a canonical v1 envelope shape", () => {
		const envelope = createObservabilityEventEnvelope({
			eventIdFactory: () => "event-1",
			ts: "2026-02-27T00:00:00.000Z",
			sessionId: "session-1",
			turn: 3,
			source: "core",
			category: "route_decided",
			severity: "info",
			payload: { route: "respond" },
		});

		expect(envelope).toEqual({
			eventId: "event-1",
			ts: "2026-02-27T00:00:00.000Z",
			sessionId: "session-1",
			turn: 3,
			source: "core",
			category: "route_decided",
			severity: "info",
			payload: { route: "respond" },
		});
		expect(isObservabilityEventEnvelope(envelope)).toBe(true);
	});

	it("rejects malformed envelopes", () => {
		expect(
			isObservabilityEventEnvelope({
				eventId: "",
				ts: "2026-02-27T00:00:00.000Z",
			}),
		).toBe(false);
	});
});

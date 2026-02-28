import { randomUUID } from "node:crypto";

export type ObservabilitySeverity = "info" | "warn" | "error";

export interface ObservabilityEventEnvelope {
	eventId: string;
	ts: string;
	sessionId: string;
	turn?: number;
	source: string;
	category: string;
	severity: ObservabilitySeverity;
	payload: Record<string, unknown>;
}

export interface CreateObservabilityEventEnvelopeInput {
	ts: string;
	sessionId?: string;
	turn?: number;
	source: string;
	category: string;
	severity: ObservabilitySeverity;
	payload?: Record<string, unknown>;
	eventIdFactory?: () => string;
}

export function createObservabilityEventEnvelope(
	input: CreateObservabilityEventEnvelopeInput,
): ObservabilityEventEnvelope {
	return {
		eventId: input.eventIdFactory?.() ?? randomUUID(),
		ts: input.ts,
		sessionId: input.sessionId?.trim() || "runtime",
		turn: input.turn,
		source: input.source,
		category: input.category,
		severity: input.severity,
		payload: input.payload ?? {},
	};
}

export function isObservabilityEventEnvelope(value: unknown): value is ObservabilityEventEnvelope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0) return false;
	if (typeof candidate.ts !== "string" || candidate.ts.length === 0) return false;
	if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) return false;
	if (typeof candidate.source !== "string" || candidate.source.length === 0) return false;
	if (typeof candidate.category !== "string" || candidate.category.length === 0) return false;
	if (candidate.severity !== "info" && candidate.severity !== "warn" && candidate.severity !== "error") return false;
	if (typeof candidate.payload !== "object" || candidate.payload === null || Array.isArray(candidate.payload)) {
		return false;
	}
	if ("turn" in candidate && typeof candidate.turn !== "number") return false;
	return true;
}

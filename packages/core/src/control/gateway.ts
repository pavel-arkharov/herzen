import { randomUUID } from "node:crypto";

export type GatewaySource = "stdin" | "wakeword" | "followup" | "automation" | "tui";

export interface GatewayEnvelope<TPayload = unknown> {
	sessionId: string;
	traceId: string;
	source: GatewaySource;
	laneKey: string;
	payload: TPayload;
}

export interface CreateGatewayEnvelopeInput<TPayload = unknown> {
	sessionId: string;
	source: GatewaySource;
	payload: TPayload;
	laneKey?: string;
	traceIdFactory?: () => string;
}

export function createGatewayEnvelope<TPayload>(
	input: CreateGatewayEnvelopeInput<TPayload>,
): GatewayEnvelope<TPayload> {
	const sessionId = input.sessionId.trim();
	if (!sessionId) {
		throw new Error("Gateway envelope requires a non-empty sessionId.");
	}

	return {
		sessionId,
		traceId: input.traceIdFactory?.() ?? randomUUID(),
		source: input.source,
		laneKey: input.laneKey ?? resolveDefaultLaneKey(sessionId, input.source),
		payload: input.payload,
	};
}

export function resolveDefaultLaneKey(sessionId: string, source: GatewaySource): string {
	if (source === "followup") return `session:${sessionId}:followup`;
	if (source === "automation") return `session:${sessionId}:automation`;
	return `session:${sessionId}:trigger`;
}

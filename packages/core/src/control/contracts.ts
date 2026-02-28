export type RouteDecisionV1 = "execute" | "clarify" | "respond" | "reject";
export type RuntimeProfile = "voice" | "text" | "hybrid";

export interface IntentRecordV1 {
	schemaVersion: "intent.v1";
	intentId: string;
	sessionId: string;
	turn: number;
	source: "deterministic" | "model";
	route: RouteDecisionV1;
	actionable: boolean;
	confidence: number;
	intentName?: string;
	entities?: Record<string, unknown>;
	modelProvider?: string;
	modelName?: string;
	traceId?: string;
	ts: string;
}

export interface CommandEnvelopeV1 {
	schemaVersion: "command.v1";
	commandId: string;
	sessionId: string;
	turn: number;
	laneKey: string;
	name: string;
	args: Record<string, unknown>;
	policyScope: string;
	idempotencyKey: string;
	traceId?: string;
	ts: string;
}

export type ExecutionPhaseV1 =
	| "ingress_accepted"
	| "ingress_processed"
	| "intent_detected"
	| "route_decided"
	| "response_started"
	| "response_succeeded"
	| "response_failed"
	| "command_started"
	| "command_succeeded"
	| "command_failed";

export interface ExecutionEventV1 {
	schemaVersion: "execution.v1";
	eventId: string;
	commandId?: string;
	intentId?: string;
	traceId?: string;
	sessionId: string;
	turn: number;
	phase: ExecutionPhaseV1;
	ok: boolean;
	code?: string;
	message?: string;
	details?: Record<string, unknown>;
	ts: string;
}

export interface ChatSendIngressPayloadV1 {
	sessionId: string;
	text: string;
	source: "tui" | "automation";
}

export interface RuntimeSetProfileIngressPayloadV1 {
	profile: RuntimeProfile;
}

export interface VoiceTriggerOnceIngressPayloadV1 {
	source?: "tui" | "automation";
}

export interface WakewordSetEnabledIngressPayloadV1 {
	enabled: boolean;
}

export interface RuntimeGetStatusIngressPayloadV1 {
	includeDiagnostics?: boolean;
}

export type ControlIngressCommandV1 =
	| "chat.send"
	| "runtime.set_profile"
	| "voice.trigger_once"
	| "wakeword.set_enabled"
	| "runtime.get_status";

interface BaseControlIngressEnvelopeV1 {
	schemaVersion: "control.ingress.v1";
	ingressId: string;
	sessionId: string;
	source: "tui" | "automation";
	traceId?: string;
	ts: string;
}

export interface ChatSendIngressEnvelopeV1 extends BaseControlIngressEnvelopeV1 {
	command: "chat.send";
	payload: ChatSendIngressPayloadV1;
}

export interface RuntimeSetProfileIngressEnvelopeV1 extends BaseControlIngressEnvelopeV1 {
	command: "runtime.set_profile";
	payload: RuntimeSetProfileIngressPayloadV1;
}

export interface VoiceTriggerOnceIngressEnvelopeV1 extends BaseControlIngressEnvelopeV1 {
	command: "voice.trigger_once";
	payload: VoiceTriggerOnceIngressPayloadV1;
}

export interface WakewordSetEnabledIngressEnvelopeV1 extends BaseControlIngressEnvelopeV1 {
	command: "wakeword.set_enabled";
	payload: WakewordSetEnabledIngressPayloadV1;
}

export interface RuntimeGetStatusIngressEnvelopeV1 extends BaseControlIngressEnvelopeV1 {
	command: "runtime.get_status";
	payload: RuntimeGetStatusIngressPayloadV1;
}

export type ControlIngressEnvelopeV1 =
	| ChatSendIngressEnvelopeV1
	| RuntimeSetProfileIngressEnvelopeV1
	| VoiceTriggerOnceIngressEnvelopeV1
	| WakewordSetEnabledIngressEnvelopeV1
	| RuntimeGetStatusIngressEnvelopeV1;

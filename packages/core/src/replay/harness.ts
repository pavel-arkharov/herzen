import { existsSync, readFileSync } from "node:fs";
import type { DeterministicIntentRouter } from "../intent/router.js";
import type { RouteDecisionV1 } from "../control/contracts.js";

export interface ReplayTurnInput {
	turn: number;
	transcript: string;
	detectedLanguage?: string;
}

export interface ReplaySessionInput {
	sessionId: string;
	turns: ReplayTurnInput[];
	recordedModelRoutes: Record<number, RouteDecisionV1>;
}

export interface ReplayTurnResult {
	turn: number;
	transcript: string;
	route: RouteDecisionV1;
	intentName?: string;
	confidence: number;
	latencyMs: number;
}

export interface ReplayMetrics {
	routeDistribution: Record<RouteDecisionV1, number>;
	falseActionProxy: {
		executeWithoutActionVerb: number;
		executeTotal: number;
	};
	clarificationRate: number;
	latency: {
		minMs: number;
		maxMs: number;
		avgMs: number;
		p95Ms: number;
	};
	modelComparison?: {
		comparedTurns: number;
		matchCount: number;
		mismatchCount: number;
		mismatches: Array<{
			turn: number;
			deterministic: RouteDecisionV1;
			recordedModel: RouteDecisionV1;
		}>;
	};
}

export interface ReplayReport {
	schemaVersion: "replay.report.v1";
	sessionId: string;
	generatedAt: string;
	mode: "deterministic" | "deterministic_with_recorded_model";
	totalTurns: number;
	metrics: ReplayMetrics;
	turns: ReplayTurnResult[];
}

export function loadReplaySessionInput(options: {
	sessionId: string;
	conversationsFile: string;
	controlSessionFile?: string;
}): ReplaySessionInput {
	const turns = loadConversationTurns(options.conversationsFile);
	const recordedModelRoutes =
		options.controlSessionFile ? loadRecordedModelRoutes(options.controlSessionFile) : {};
	return {
		sessionId: options.sessionId,
		turns,
		recordedModelRoutes,
	};
}

export function replayDeterministicSession(options: {
	sessionId: string;
	router: DeterministicIntentRouter;
	turns: ReplayTurnInput[];
	recordedModelRoutes?: Record<number, RouteDecisionV1>;
	nowIso?: () => string;
}): ReplayReport {
	const turnResults: ReplayTurnResult[] = options.turns.map((turnInput) => {
		const startedAt = process.hrtime.bigint();
		const decision = options.router.route({
			transcript: turnInput.transcript,
			detectedLanguage: turnInput.detectedLanguage,
			sessionId: options.sessionId,
			laneKey: `replay:${options.sessionId}`,
			turn: turnInput.turn,
		});
		const finishedAt = process.hrtime.bigint();
		const latencyMs = Number(finishedAt - startedAt) / 1_000_000;
		return {
			turn: turnInput.turn,
			transcript: turnInput.transcript,
			route: decision.kind,
			intentName: "intentName" in decision ? decision.intentName : undefined,
			confidence: decision.confidence,
			latencyMs,
		};
	});

	const metrics = computeReplayMetrics(
		turnResults,
		options.recordedModelRoutes ?? {},
	);
	const comparedTurns = Object.keys(options.recordedModelRoutes ?? {}).length;
	return {
		schemaVersion: "replay.report.v1",
		sessionId: options.sessionId,
		generatedAt: (options.nowIso ?? (() => new Date().toISOString()))(),
		mode: comparedTurns > 0 ? "deterministic_with_recorded_model" : "deterministic",
		totalTurns: turnResults.length,
		metrics,
		turns: turnResults,
	};
}

export function formatReplayReport(report: ReplayReport): string {
	const lines: string[] = [];
	lines.push(`Replay Report: ${report.sessionId}`);
	lines.push(`Mode: ${report.mode}`);
	lines.push(`Turns: ${report.totalTurns}`);
	lines.push(
		`Routes: execute=${report.metrics.routeDistribution.execute}, clarify=${report.metrics.routeDistribution.clarify}, respond=${report.metrics.routeDistribution.respond}, reject=${report.metrics.routeDistribution.reject}`,
	);
	lines.push(
		`Clarification rate: ${(report.metrics.clarificationRate * 100).toFixed(1)}% (${report.metrics.routeDistribution.clarify}/${report.totalTurns})`,
	);
	lines.push(
		`False-action proxy: ${report.metrics.falseActionProxy.executeWithoutActionVerb}/${report.metrics.falseActionProxy.executeTotal}`,
	);
	lines.push(
		`Latency ms: min=${report.metrics.latency.minMs.toFixed(3)} avg=${report.metrics.latency.avgMs.toFixed(3)} p95=${report.metrics.latency.p95Ms.toFixed(3)} max=${report.metrics.latency.maxMs.toFixed(3)}`,
	);
	if (report.metrics.modelComparison) {
		lines.push(
			`Model comparison: matched=${report.metrics.modelComparison.matchCount} mismatched=${report.metrics.modelComparison.mismatchCount} compared=${report.metrics.modelComparison.comparedTurns}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function loadConversationTurns(filePath: string): ReplayTurnInput[] {
	const records = readJsonl(filePath);
	const turns: ReplayTurnInput[] = [];
	for (const record of records) {
		if (!isRecord(record)) continue;
		if (record.type !== "user_utterance") continue;
		const turn = toNumber(record.turn);
		const transcript = toString(record.text).trim();
		if (turn === undefined || !transcript) continue;
		turns.push({
			turn,
			transcript,
			detectedLanguage: toString(record.detectedLanguage) || undefined,
		});
	}
	turns.sort((left, right) => left.turn - right.turn);
	return turns;
}

function loadRecordedModelRoutes(filePath: string): Record<number, RouteDecisionV1> {
	const records = readJsonl(filePath);
	const byTurn: Record<number, RouteDecisionV1> = {};
	for (const entry of records) {
		if (!isRecord(entry)) continue;
		if (entry.stream !== "intent") continue;
		const record = entry.record;
		if (!isRecord(record)) continue;
		if (record.source !== "model") continue;
		const turn = toNumber(record.turn);
		const route = toRoute(record.route);
		if (turn === undefined || !route) continue;
		byTurn[turn] = route;
	}
	return byTurn;
}

function computeReplayMetrics(
	turns: ReplayTurnResult[],
	recordedModelRoutes: Record<number, RouteDecisionV1>,
): ReplayMetrics {
	const routeDistribution: Record<RouteDecisionV1, number> = {
		execute: 0,
		clarify: 0,
		respond: 0,
		reject: 0,
	};
	let executeWithoutActionVerb = 0;
	for (const turn of turns) {
		routeDistribution[turn.route] += 1;
		if (turn.route === "execute" && !containsActionVerb(turn.transcript)) {
			executeWithoutActionVerb += 1;
		}
	}

	const latencies = turns.map((turn) => turn.latencyMs).sort((left, right) => left - right);
	const avgLatency = latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
	const p95Index = latencies.length > 0 ? Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95)) : 0;

	const modelComparison = buildModelComparison(turns, recordedModelRoutes);

	return {
		routeDistribution,
		falseActionProxy: {
			executeWithoutActionVerb,
			executeTotal: routeDistribution.execute,
		},
		clarificationRate: turns.length > 0 ? routeDistribution.clarify / turns.length : 0,
		latency: {
			minMs: latencies[0] ?? 0,
			maxMs: latencies[latencies.length - 1] ?? 0,
			avgMs: avgLatency,
			p95Ms: latencies[p95Index] ?? 0,
		},
		modelComparison,
	};
}

function buildModelComparison(
	turns: ReplayTurnResult[],
	recordedModelRoutes: Record<number, RouteDecisionV1>,
): ReplayMetrics["modelComparison"] {
	const comparedTurns = Object.keys(recordedModelRoutes).length;
	if (comparedTurns === 0) return undefined;

	const byTurn = new Map<number, RouteDecisionV1>();
	for (const turn of turns) byTurn.set(turn.turn, turn.route);

	const mismatches: Array<{
		turn: number;
		deterministic: RouteDecisionV1;
		recordedModel: RouteDecisionV1;
	}> = [];
	let matchCount = 0;
	for (const [turnRaw, modelRoute] of Object.entries(recordedModelRoutes)) {
		const turn = Number.parseInt(turnRaw, 10);
		const deterministicRoute = byTurn.get(turn);
		if (!deterministicRoute) continue;
		if (deterministicRoute === modelRoute) {
			matchCount += 1;
			continue;
		}
		mismatches.push({
			turn,
			deterministic: deterministicRoute,
			recordedModel: modelRoute,
		});
	}

	return {
		comparedTurns,
		matchCount,
		mismatchCount: mismatches.length,
		mismatches,
	};
}

function containsActionVerb(text: string): boolean {
	return /(turn on|turn off|switch on|switch off|scene|включи|выключи)/iu.test(text);
}

function readJsonl(filePath: string): unknown[] {
	if (!existsSync(filePath)) return [];
	const raw = safeReadUtf8(filePath);
	if (raw === undefined) return [];
	const lines = raw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const records: unknown[] = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line));
		} catch {
			continue;
		}
	}
	return records;
}

function safeReadUtf8(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toRoute(value: unknown): RouteDecisionV1 | null {
	if (value === "execute" || value === "clarify" || value === "respond" || value === "reject") {
		return value;
	}
	return null;
}

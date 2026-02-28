import {
	playConversationClosedCue,
	playAudio,
	playInputStartCue,
	recordAdaptiveWav,
	recordWav,
} from "@herzen/audio";
import { createResponseService } from "@herzen/dialog";
import {
	createHomeAssistantService,
	resolveHomeAssistantConfig,
	type HomeAssistantCommandExecutionResult,
} from "@herzen/integration-homeassistant";
import { transcribeWav, SttError } from "@herzen/stt";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { speak } from "@herzen/tts";
import { resolveDataRoot } from "./app/paths.js";
import {
	type AssistantUtteranceRecord,
	type RunSttTurnOptions,
	runTextTurn,
	type ResponseErrorLike,
	type SttLogEntry,
	type TriggerTurnDependencies,
	type TurnOutcome,
	type UserUtteranceRecord,
	runSttTurn,
} from "./app/turn.js";
import { createDialogJournal, type DialogJournal, type SessionSettingsSnapshot } from "./conversation/journal.js";
import { createContextAssembler } from "./context/assembler.js";
import { resolveContextBudget } from "./context/budget.js";
import { createContextCompactor } from "./context/compactor.js";
import { createSessionSummaryStore } from "./context/summary.js";
import { ConversationContextWindow, resolveContextWindowConfig } from "./conversation/context_window.js";
import { isFollowupStopPhrase, resolveFollowupConfig } from "./conversation/followup_config.js";
import { runFollowupSession } from "./conversation/followup_session.js";
import type {
	CommandEnvelopeV1,
	ExecutionEventV1,
	IntentRecordV1,
	RouteDecisionV1,
	RuntimeProfile,
} from "./control/contracts.js";
import { createCommandRegistry } from "./control/command_registry.js";
import { createCoreStatusWriter, type CoreState } from "./control/core_status.js";
import { createControlEventStore, type ControlEventStore } from "./control/event_store.js";
import { createGatewayEnvelope, type GatewaySource } from "./control/gateway.js";
import {
	createControlIngressReader,
	type ChatIngressCommand,
	type ControlIngressCommand,
} from "./control/ingress.js";
import { registerHomeAssistantCommands } from "./control/ha_commands.js";
import { createLaneScheduler } from "./control/lanes.js";
import { createPolicyGate } from "./control/policy_gate.js";
import { createDeterministicIntentRouter } from "./intent/router.js";
import { pruneLogDirectory } from "./observability/log_retention.js";
import { createLogger, toStructuredSttTurnEntry } from "./observability/logging.js";
import { createPerfJournal, createProcessSampleCollector, type PerfJournal } from "./observability/perf_journal.js";
import { resolveSettings } from "./settings/registry.js";
import { loadRuntimeEnvOverrides } from "./settings/runtime_overrides.js";
import {
	resolveInitialAdaptiveMaxSecondsInteractive,
	resolveInitialRecordingModeInteractive,
	type RecordingMode,
} from "./recording/factory.js";
import {
	createTriggerSource,
	resolveInitialTriggerModeInteractive,
} from "./trigger/factory.js";
import { isTriggerError, type TriggerMode } from "./trigger/types.js";

const DEFAULT_RESPONSE_TEMPERATURE = 0.2;
const DEFAULT_RESPONSE_TIMEOUT_MS = 12_000;

const dataRoot = resolveDataRoot();
const outDir = join(dataRoot, "audio");
const logsDir = join(dataRoot, "logs");
const conversationsDir = join(dataRoot, "conversations");
const controlDir = join(dataRoot, "control");
const runtimeSessionId = randomUUID();
const runtimeSettingsEnvOverrides = loadRuntimeEnvOverrides(controlDir);
const bootSettings = resolveSettings({
	...process.env,
	...runtimeSettingsEnvOverrides,
});
mkdirSync(outDir, { recursive: true });

function resolveNumber(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseFloat(trimmed);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePositiveInteger(rawValue: string | undefined, fallback: number): number {
	const trimmed = rawValue?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const logAudioInputEnabled = bootSettings.logging.audioInputEnabled;

const coreLogger = createLogger({
	logsDir,
	component: "core",
	sessionId: runtimeSessionId,
	env: {
		...process.env,
		...runtimeSettingsEnvOverrides,
	},
});

const triggerLogger = createLogger({
	logsDir,
	component: "trigger",
	sessionId: runtimeSessionId,
	env: {
		...process.env,
		...runtimeSettingsEnvOverrides,
	},
});

const sttLogger = createLogger({
	logsDir,
	component: "stt",
	sessionId: runtimeSessionId,
	env: {
		...process.env,
		...runtimeSettingsEnvOverrides,
	},
});

const perfJournal = createPerfJournal({
	writer: coreLogger,
	sessionId: runtimeSessionId,
	enabled: bootSettings.logging.perfEnabled,
});
const perfSampleIntervalMs = bootSettings.logging.perfSampleMs;
const collectProcessSample = createProcessSampleCollector();

let processSampleTimer: NodeJS.Timeout | null = null;
let ingressPollTimer: NodeJS.Timeout | null = null;
let statusHeartbeatTimer: NodeJS.Timeout | null = null;

function asMessage(args: unknown[]): string {
	return format(...args);
}

async function appendSttLog(entry: SttLogEntry): Promise<void> {
	await sttLogger.appendJsonl(
		"stt",
		toStructuredSttTurnEntry(entry, {
			transcriptEnabled: sttLogger.transcriptEnabled,
			audioInputEnabled: logAudioInputEnabled,
			sessionId: runtimeSessionId,
		}),
	);
}

const sttTurnLogger = {
	log: (...args: unknown[]) => {
		sttLogger.info("stt.status", { message: asMessage(args) });
	},
	error: (...args: unknown[]) => {
		sttLogger.error("stt.error", { message: asMessage(args) });
	},
};

const runtimeLogger = {
	log: (...args: unknown[]) => {
		coreLogger.info("core.runtime", { message: asMessage(args) });
	},
	error: (...args: unknown[]) => {
		coreLogger.error("core.runtime_error", { message: asMessage(args) });
	},
};

function startProcessSampling(): void {
	if (!perfJournal.enabled) return;
	if (processSampleTimer) return;
	processSampleTimer = setInterval(() => {
		void perfJournal.recordProcessSample(collectProcessSample());
	}, perfSampleIntervalMs);
}

function stopProcessSampling(): void {
	if (!processSampleTimer) return;
	clearInterval(processSampleTimer);
	processSampleTimer = null;
}

function startIngressPolling(poller: () => Promise<void>, intervalMs = 250): void {
	if (ingressPollTimer) return;
	ingressPollTimer = setInterval(() => {
		void poller();
	}, intervalMs);
}

function stopIngressPolling(): void {
	if (!ingressPollTimer) return;
	clearInterval(ingressPollTimer);
	ingressPollTimer = null;
}

let dialogJournal: DialogJournal | null = null;
let controlEventStore: ControlEventStore | null = null;
const coreStatusWriter = createCoreStatusWriter({
	controlDir,
	sessionId: runtimeSessionId,
	initialProfile: bootSettings.runtime.profile,
});
let currentCoreState: CoreState = "starting";
let stopRuntime: (() => Promise<void>) | null = null;

async function updateCoreStatus(
	patch: Parameters<typeof coreStatusWriter.update>[0],
): Promise<void> {
	try {
		if (patch.coreState) currentCoreState = patch.coreState;
		await coreStatusWriter.update(patch);
	} catch (err) {
		coreLogger.warn("core.status_heartbeat_write_failed", {
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

function startStatusHeartbeat(intervalMs = 1200): void {
	if (statusHeartbeatTimer) return;
	statusHeartbeatTimer = setInterval(() => {
		void coreStatusWriter.beat();
	}, intervalMs);
}

function stopStatusHeartbeat(): void {
	if (!statusHeartbeatTimer) return;
	clearInterval(statusHeartbeatTimer);
	statusHeartbeatTimer = null;
}

async function flushAndExit(code: number): Promise<void> {
	if (currentCoreState !== "stopping") {
		await updateCoreStatus({
			coreState: "stopping",
		});
	}
	stopStatusHeartbeat();
	if (stopRuntime) {
		await stopRuntime();
		stopRuntime = null;
	}
	stopProcessSampling();
	stopIngressPolling();
	await perfJournal.recordPhase({
		phase: "runtime",
		status: code === 0 ? "ok" : "error",
		mode: "runtime",
		fields: {
			exitCode: code,
		},
	});
	await dialogJournal?.recordSessionEnded({
		reason: code === 0 ? "normal_shutdown" : "runtime_error",
	});
	await Promise.all([
		coreLogger.drain(),
		triggerLogger.drain(),
		sttLogger.drain(),
		dialogJournal?.drain() ?? Promise.resolve(),
		controlEventStore?.drain() ?? Promise.resolve(),
	]);
	process.exit(code);
}

async function recordWithProgress(file: string, seconds: number): Promise<void> {
	const startedAt = Date.now();
	const barWidth = 26;

	const render = (forceDone = false) => {
		const elapsedSeconds = forceDone ? seconds : Math.min((Date.now() - startedAt) / 1000, seconds);
		const ratio = Math.max(0, Math.min(1, elapsedSeconds / seconds));
		const filled = Math.round(barWidth * ratio);
		const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
		process.stdout.write(`\rRecording [${bar}] ${elapsedSeconds.toFixed(1)}s/${seconds.toFixed(1)}s`);
		if (forceDone) process.stdout.write("\n");
	};

	render(false);
	const ticker = setInterval(() => render(false), 100);

	try {
		await recordWav(file, seconds);
	} finally {
		clearInterval(ticker);
		render(true);
	}
}

function createHandleTrigger(
	recordingMode: RecordingMode,
	triggerMode: TriggerMode,
	runtimeEnvSnapshot: NodeJS.ProcessEnv,
	journal: DialogJournal | null,
	perf: PerfJournal,
): {
	onTrigger: () => Promise<void>;
	onTextIngress: (command: ChatIngressCommand) => Promise<void>;
} {
	const getRuntimeEnv = () => runtimeEnvSnapshot;
	const contextConfig = resolveContextWindowConfig(getRuntimeEnv(), {
		warn: (...args: unknown[]) => {
			coreLogger.warn("core.context_window_config", { message: asMessage(args) });
		},
	});
	const followupConfig = resolveFollowupConfig(getRuntimeEnv(), {
		warn: (...args: unknown[]) => {
			coreLogger.warn("core.followup_config", { message: asMessage(args) });
		},
	});
	if (followupConfig.enabled) {
		runtimeLogger.log(
			`Follow-up mode: enabled (${followupConfig.windowSeconds.toFixed(1)}s window, ${followupConfig.maxTurns} max turns).`,
		);
	} else {
		runtimeLogger.log("Follow-up mode: disabled (set HERZEN_FOLLOWUP_ENABLED=1 to enable).");
	}
	const laneScheduler = createLaneScheduler({
		maxGlobalConcurrency: resolvePositiveInteger(
			getRuntimeEnv().HERZEN_LANE_MAX_GLOBAL_CONCURRENCY,
			1,
		),
		onMetric: (event) => {
			coreLogger.info("core.lane_metric", {
				laneKey: event.laneKey,
				queueDepth: event.queueDepth,
				waitMs: Math.round(event.waitMs),
			});
		},
	});
	const appendIntentRecord = async (
		event: Omit<IntentRecordV1, "schemaVersion" | "intentId" | "sessionId" | "ts">,
	): Promise<string> => {
		const intentId = randomUUID();
		try {
			await controlEventStore?.appendIntent({
				schemaVersion: "intent.v1",
				intentId,
				sessionId: runtimeSessionId,
				ts: new Date().toISOString(),
				...event,
			});
		} catch (err) {
			coreLogger.warn("core.control_intent_write_failed", {
				message: err instanceof Error ? err.message : "Unknown control intent write error.",
			});
		}
		return intentId;
	};

	const appendCommandEnvelope = async (
		event: Omit<CommandEnvelopeV1, "schemaVersion" | "commandId" | "sessionId" | "ts">,
	): Promise<string> => {
		const commandId = randomUUID();
		try {
			await controlEventStore?.appendCommand({
				schemaVersion: "command.v1",
				commandId,
				sessionId: runtimeSessionId,
				ts: new Date().toISOString(),
				...event,
			});
		} catch (err) {
			coreLogger.warn("core.control_command_write_failed", {
				message: err instanceof Error ? err.message : "Unknown control command write error.",
			});
		}
		return commandId;
	};

	const appendExecutionEvent = async (
		event: Omit<ExecutionEventV1, "schemaVersion" | "eventId" | "sessionId" | "ts">,
	): Promise<void> => {
		try {
			await controlEventStore?.appendExecution({
				schemaVersion: "execution.v1",
				eventId: randomUUID(),
				sessionId: runtimeSessionId,
				ts: new Date().toISOString(),
				...event,
			});
		} catch (err) {
			coreLogger.warn("core.control_execution_write_failed", {
				message: err instanceof Error ? err.message : "Unknown control execution write error.",
			});
		}
	};
	const contextWindow = new ConversationContextWindow(contextConfig);
	const contextBudget = resolveContextBudget(getRuntimeEnv(), {
		warn: (...args: unknown[]) => {
			coreLogger.warn("core.context_budget_config", { message: asMessage(args) });
		},
	});
	const contextAssembler = createContextAssembler(contextBudget);
	const summaryStore = createSessionSummaryStore({
		conversationsDir,
		sessionId: runtimeSessionId,
	});
	const contextCompactor = createContextCompactor({
		sessionId: runtimeSessionId,
		summaryStore,
	});
	const responseService = resolveResponseService(getRuntimeEnv());
	const homeAssistantRouterConfig = resolveHomeAssistantRouterConfig(getRuntimeEnv());
	const homeAssistantService = resolveHomeAssistantService(getRuntimeEnv());
	const intentRouter = createDeterministicIntentRouter({
		homeAssistantConfig: homeAssistantRouterConfig,
	});
	const policyGate = createPolicyGate({
		allowedScopes: resolveSettings(getRuntimeEnv()).control.allowedScopes,
	});
	const commandRegistry = createCommandRegistry({ policyGate });
	if (homeAssistantService?.enabled) {
		registerHomeAssistantCommands(commandRegistry, {
			service: homeAssistantService,
			allowedLights: homeAssistantRouterConfig?.allowedLights ?? [],
		});
	}
	if (homeAssistantService?.enabled) {
		runtimeLogger.log("Home Assistant integration: enabled.");
	} else {
		runtimeLogger.log("Home Assistant integration: disabled (set HERZEN_HA_ENABLED=1 to enable).");
	}
	const onUserUtterance = async (event: UserUtteranceRecord) => {
		await journal?.recordUserUtterance(event);
	};
	const onAssistantUtterance = async (event: AssistantUtteranceRecord) => {
		await journal?.recordAssistantUtterance(event);
	};
	const onError = async (event: {
		turn: number;
		stage: "stt" | "response" | "telemetry";
		code?: string;
		message: string;
		details?: Record<string, unknown>;
	}) => {
		await journal?.recordError(event);
	};

	const recordActionCall = async (
		turnNumber: number,
		integration: string,
		operation: string,
		args: Record<string, unknown>,
	): Promise<void> => {
		try {
			await journal?.recordActionCall({
				turn: turnNumber,
				integration,
				operation,
				args,
			});
		} catch (err) {
			sttTurnLogger.error("Failed to write action_call journal event:", err);
		}
	};

	const recordActionResult = async (
		turnNumber: number,
		integration: string,
		operation: string,
		result: Record<string, unknown>,
	): Promise<void> => {
		try {
			await journal?.recordActionResult({
				turn: turnNumber,
				integration,
				operation,
				result,
			});
		} catch (err) {
			sttTurnLogger.error("Failed to write action_result journal event:", err);
		}
	};

	const turnDeps: TriggerTurnDependencies = {
		outDir,
		getEnv: getRuntimeEnv,
		now: () => Date.now(),
		nowIso: () => new Date().toISOString(),
		logger: sttTurnLogger,
		recordingMode,
		playInputStartCue,
		recordAudioFixed: async (file, seconds) => {
			await recordWithProgress(file, seconds);
		},
		recordAudioAdaptive: async (file, config) => {
			const env = getRuntimeEnv();
			return recordAdaptiveWav(file, {
				...config,
				modelPath: env.HERZEN_VAD_MODEL,
				dataDir: env.HERZEN_DATA_DIR,
			});
		},
		transcribeWav,
		isSttError: (err): err is SttError => err instanceof SttError,
		generateResponse:
			responseService || homeAssistantService?.enabled ?
				async (input) => {
					const turn = typeof input.turn === "number" ? input.turn : undefined;
					const traceId = input.control?.traceId;
					const laneKey = input.control?.laneKey ?? `session:${runtimeSessionId}:trigger`;

					const emitRouteDecision = async (
						route: RouteDecisionV1,
						event: {
							actionable: boolean;
							intentName?: string;
							entities?: Record<string, unknown>;
							confidence?: number;
						},
					): Promise<string | undefined> => {
						if (!turn) return undefined;
						const intentId = await appendIntentRecord({
							turn,
							source: "deterministic",
							route,
							actionable: event.actionable,
							confidence: event.confidence ?? (route === "execute" ? 1 : 0.8),
							intentName: event.intentName,
							entities: event.entities,
							traceId,
						});
						await appendExecutionEvent({
							turn,
							intentId,
							traceId,
							phase: "intent_detected",
							ok: true,
							details: {
								actionable: event.actionable,
								intentName: event.intentName,
							},
						});
						await appendExecutionEvent({
							turn,
							intentId,
							traceId,
							phase: "route_decided",
							ok: route !== "reject",
							details: {
								route,
							},
						});
						return intentId;
					};

					const routeDecision = intentRouter.route({
						transcript: input.transcript,
						detectedLanguage: input.detectedLanguage,
						sessionId: runtimeSessionId,
						laneKey,
						turn,
					});
					const intentId = await emitRouteDecision(routeDecision.kind, {
						actionable: routeDecision.kind === "execute",
						intentName:
							"intentName" in routeDecision ? routeDecision.intentName : undefined,
						entities:
							"entities" in routeDecision ? routeDecision.entities : undefined,
						confidence: routeDecision.confidence,
					});

					const emitResponseStarted = async (route: RouteDecisionV1): Promise<void> => {
						if (!turn) return;
						await appendExecutionEvent({
							turn,
							intentId,
							traceId,
							phase: "response_started",
							ok: true,
							details: {
								route,
							},
						});
					};

					const emitResponseSucceeded = async (
						route: RouteDecisionV1,
						details?: Record<string, unknown>,
					): Promise<void> => {
						if (!turn) return;
						await appendExecutionEvent({
							turn,
							intentId,
							traceId,
							phase: "response_succeeded",
							ok: true,
							details: {
								route,
								...details,
							},
						});
					};

					const emitResponseFailed = async (
						route: RouteDecisionV1,
						event: {
							code: string;
							message: string;
						},
					): Promise<void> => {
						if (!turn) return;
						await appendExecutionEvent({
							turn,
							intentId,
							traceId,
							phase: "response_failed",
							ok: false,
							code: event.code,
							message: event.message,
							details: {
								route,
							},
						});
					};

					if (routeDecision.kind === "clarify") {
						await emitResponseStarted("clarify");
						await emitResponseSucceeded("clarify", {
							missingFields: routeDecision.missingFields,
						});
						return {
							text: routeDecision.prompt,
							language: /[А-Яа-яЁё]/u.test(input.transcript) ? "ru" : "en",
							provider: "deterministic_router",
							model: "clarify",
							durationMs: 0,
						};
					}

					if (routeDecision.kind === "reject") {
						await emitResponseStarted("reject");
						await emitResponseSucceeded("reject", {
							reason: routeDecision.reason,
						});
						return {
							text:
								/[А-Яа-яЁё]/u.test(input.transcript)
									? "[ru] Не могу выполнить такой запрос."
									: "[en] I can't help with that request.",
							language: /[А-Яа-яЁё]/u.test(input.transcript) ? "ru" : "en",
							provider: "deterministic_router",
							model: "reject",
							durationMs: 0,
						};
					}

					if (routeDecision.kind === "execute") {
						await emitResponseStarted("execute");
						const idempotencyKey =
							turn ?
								`${runtimeSessionId}:${turn}:${routeDecision.command.name}`
							: `${runtimeSessionId}:${Date.now()}:${routeDecision.command.name}`;
						const commandId =
							turn ?
								await appendCommandEnvelope({
									turn,
									laneKey,
									name: routeDecision.command.name,
									args: routeDecision.command.args,
									policyScope: routeDecision.command.policyScope,
									idempotencyKey,
									traceId,
								})
							: undefined;
						if (turn && commandId) {
							await appendExecutionEvent({
								turn,
								intentId,
								traceId,
								commandId,
								phase: "command_started",
								ok: true,
								details: {
									command: routeDecision.command.name,
								},
							});
						}

						const haIntentStartedAtMs = Date.now();
						const commandResult = await commandRegistry.execute(
							{
								name: routeDecision.command.name,
								args: routeDecision.command.args,
								policyScope: routeDecision.command.policyScope,
								idempotencyKey,
							},
							{
								sessionId: runtimeSessionId,
								turn: turn ?? 0,
								laneKey,
								traceId,
								languageHint: input.detectedLanguage ?? input.transcript,
							},
						);
						const haIntentFinishedAtMs = Date.now();

						if (!commandResult.ok) {
							if (turn && commandId) {
								await appendExecutionEvent({
									turn,
									intentId,
									traceId,
									commandId,
									phase: "command_failed",
									ok: false,
									code: commandResult.code,
									message: commandResult.message,
									details: commandResult.details,
								});
							}
							await emitResponseFailed("execute", {
								code: commandResult.code,
								message: commandResult.message,
							});
							const failureText = resolveCommandFailureSpeech({
								transcript: input.transcript,
								code: commandResult.code,
								message: commandResult.message,
								details: commandResult.details,
							});
							return {
								text: failureText.text,
								language: failureText.language,
								provider: "command_registry",
								model: commandResult.code,
								durationMs: 0,
								actionPath: "home_assistant",
								haIntentStartedAtMs,
								haIntentFinishedAtMs,
							};
						}

						const handledAction = commandResult.result as HomeAssistantCommandExecutionResult;
						if (turn && commandId) {
							await appendExecutionEvent({
								turn,
								intentId,
								traceId,
								commandId,
								phase: "command_succeeded",
								ok: true,
								details: {
									statusCode: handledAction.result.statusCode,
								},
							});
						}
						if (turn) {
							await recordActionCall(turn, handledAction.integration, handledAction.operation, handledAction.args);
							await recordActionResult(turn, handledAction.integration, handledAction.operation, {
								ok: handledAction.result.ok,
								code: handledAction.result.code,
								statusCode: handledAction.result.statusCode,
								message: handledAction.result.message,
								entity_id: handledAction.entityId || undefined,
								matchedAlias: handledAction.matchedAlias,
							});
						}
						await emitResponseSucceeded("execute", {
							command: routeDecision.command.name,
						});
						return {
							text: handledAction.assistantText,
							language: handledAction.language,
							provider: handledAction.integration,
							model: handledAction.operation,
							durationMs: handledAction.durationMs,
							actionPath: "home_assistant",
							haIntentStartedAtMs,
							haIntentFinishedAtMs,
						};
					}

					if (!responseService) {
						await emitResponseStarted("respond");
						await emitResponseFailed("respond", {
							code: "RESPONSE_UNAVAILABLE",
							message: "LLM response service unavailable.",
						});
						throw {
							code: "RESPONSE_UNAVAILABLE",
							message: "LLM response service unavailable.",
						};
					}

					await emitResponseStarted("respond");
					const llmStartedAtMs = Date.now();
					let response: Awaited<ReturnType<NonNullable<typeof responseService>["generateReply"]>>;
					try {
						response = await responseService.generateReply(input);
					} catch (err) {
						await emitResponseFailed("respond", {
							code: isResponseError(err) ? err.code : "RESPONSE_UNAVAILABLE",
							message: isResponseError(err) ? err.message : "Failed to generate response.",
						});
						throw err;
					}
					const llmFinishedAtMs = Date.now();
					await emitResponseSucceeded("respond", {
						provider: response.provider,
						model: response.model,
					});
					return {
						...response,
						actionPath: "llm",
						llmStartedAtMs,
						llmFinishedAtMs,
					};
				}
			: undefined,
		isResponseError,
		getConversationContext: (contextInput) => {
			const assembledContext = contextAssembler.assemble({
				kernelPrompt: resolveContextKernelPrompt(getRuntimeEnv()),
				summary: contextCompactor.getSummary(),
				recentTurns: contextWindow.snapshot(),
				currentInput: contextInput.transcript,
			});
			return assembledContext.conversationContext;
		},
		onUserUtterance,
		onAssistantUtterance,
		onError,
		appendSttLog,
		appendPerfEvent: async (event) => {
			await perf.recordPhase(event);
		},
		appendTurnBenchmark: async (entry) => {
			await coreLogger.appendJsonl("turn_benchmark", {
				...entry,
				sessionId: runtimeSessionId,
			});
		},
		playAudio,
		speak,
	};

	let turn = 0;

	const onTurnOutcome = async (outcome: TurnOutcome): Promise<void> => {
		if (!outcome.hasTranscript || !outcome.transcript) return;

		contextWindow.appendUser(
			outcome.turn,
			outcome.transcript,
			normalizeContextLanguage(outcome.detectedLanguage),
		);
		if (outcome.assistantSource === "model") {
			contextWindow.appendAssistant(outcome.turn, outcome.assistantText, outcome.assistantLanguage);
		}

		const compactionProbe = contextAssembler.assemble({
			kernelPrompt: resolveContextKernelPrompt(getRuntimeEnv()),
			summary: contextCompactor.getSummary(),
			recentTurns: contextWindow.snapshot(),
			currentInput: outcome.transcript,
		});
		const compaction = await contextCompactor.maybeCompact({
			turn: outcome.turn,
			recentTurns: contextWindow.snapshot(),
			overflow: compactionProbe.overflow,
			summaryCharBudget: contextBudget.summaryChars,
		});
		if (!compaction.compacted) return;
		contextWindow.replace(compaction.prunedRecentTurns);
		coreLogger.info("core.context_compacted", {
			turn: outcome.turn,
			reason: compaction.reason,
			sourceEventIds: compaction.sourceEventIds,
			summaryChars: compaction.summary?.summary.length ?? 0,
			prunedItems: compaction.prunedRecentTurns.length,
		});
	};

	const resolveIngressSource = (options: RunSttTurnOptions): GatewaySource => {
		if (options.mode === "followup") return "followup";
		return triggerMode === "wakeword" ? "wakeword" : "stdin";
	};

	const runTurn = async (options: RunSttTurnOptions): Promise<TurnOutcome> => {
		const turnNumber = ++turn;
		const source = resolveIngressSource(options);
		const envelope = createGatewayEnvelope({
			sessionId: runtimeSessionId,
			source,
			payload: {
				turn: turnNumber,
				mode: options.mode ?? "trigger",
				triggerMode,
			},
		});
		coreLogger.info("core.gateway_ingress", {
			traceId: envelope.traceId,
			source: envelope.source,
			laneKey: envelope.laneKey,
			queueDepth: laneScheduler.getQueueDepth(envelope.laneKey),
			turn: turnNumber,
		});
		const outcome = await laneScheduler.submit(envelope.laneKey, async () =>
			runSttTurn(turnDeps, turnNumber, {
				...options,
				triggerMode,
				ingressSource: "voice",
				traceId: envelope.traceId,
				laneKey: envelope.laneKey,
				triggerReceivedAtMs: options.triggerReceivedAtMs ?? Date.now(),
			}),
		);
		await onTurnOutcome(outcome);
		return outcome;
	};
	const runTextIngressTurn = async (command: ChatIngressCommand): Promise<void> => {
		if (command.sessionId !== runtimeSessionId) return;
		const turnNumber = ++turn;
		const envelope = createGatewayEnvelope({
			sessionId: runtimeSessionId,
			source: "tui",
			payload: {
				turn: turnNumber,
				mode: "trigger",
				triggerMode: "stdin",
				ingressId: command.ingressId,
			},
			traceIdFactory: command.traceId ? () => command.traceId ?? randomUUID() : undefined,
		});
		coreLogger.info("core.gateway_ingress", {
			traceId: envelope.traceId,
			source: envelope.source,
			laneKey: envelope.laneKey,
			queueDepth: laneScheduler.getQueueDepth(envelope.laneKey),
			turn: turnNumber,
			ingressId: command.ingressId,
		});
		await appendExecutionEvent({
			turn: turnNumber,
			traceId: envelope.traceId,
			phase: "ingress_accepted",
			ok: true,
			details: {
				ackState: "accepted",
				command: command.command,
				ingressId: command.ingressId,
				source: command.source,
			},
		});
		let outcome: TurnOutcome;
		try {
			outcome = await laneScheduler.submit(envelope.laneKey, async () =>
				runTextTurn(turnDeps, turnNumber, command.text, {
					mode: "trigger",
					triggerMode: "stdin",
					ingressSource: command.source,
					traceId: envelope.traceId,
					laneKey: envelope.laneKey,
					triggerReceivedAtMs: Date.now(),
				}),
			);
		} catch (err) {
			await appendExecutionEvent({
				turn: turnNumber,
				traceId: envelope.traceId,
				phase: "ingress_processed",
				ok: false,
				code: "INGRESS_PROCESSING_FAILED",
				message: err instanceof Error ? err.message : String(err),
				details: {
					ackState: "failed",
					command: command.command,
					ingressId: command.ingressId,
					source: command.source,
				},
			});
			throw err;
		}
		await appendExecutionEvent({
			turn: turnNumber,
			traceId: envelope.traceId,
			phase: "ingress_processed",
			ok: true,
			details: {
				ackState: "applied",
				command: command.command,
				ingressId: command.ingressId,
				source: command.source,
			},
		});
		await onTurnOutcome(outcome);
	};

	const onTrigger = async () => {
		const initialTurn = await runTurn({
			mode: "trigger",
			triggerReceivedAtMs: Date.now(),
		});
		const followupResult = await runFollowupSession({
			initialTurn,
			config: followupConfig,
			nowMs: () => Date.now(),
			runTurn,
			isStopPhrase: (transcript) => isFollowupStopPhrase(transcript, followupConfig.stopPhrases),
			callbacks: {
				onWindowOpened: async (event) => {
						runtimeLogger.log(
							`Follow-up window opened (${event.windowSeconds.toFixed(1)}s, max turns ${event.maxTurns}).`,
						);
						await perf.recordPhase({
							phase: "followup",
							status: "started",
							turn: initialTurn.turn,
							mode: "followup",
							fields: {
								action: "window_opened",
								windowSeconds: event.windowSeconds,
								maxTurns: event.maxTurns,
							},
						});
						await recordActionCall(initialTurn.turn, "core.followup", "window_opened", {
							windowSeconds: event.windowSeconds,
							maxTurns: event.maxTurns,
							stopPhrases: followupConfig.stopPhrases,
						});
					},
				onTurnStarted: async (event) => {
						runtimeLogger.log(
							`Follow-up turn ${event.index} started (${Math.round(event.remainingWindowMs)}ms remaining).`,
						);
						await perf.recordPhase({
							phase: "followup",
							status: "started",
							turn: initialTurn.turn + event.index,
							mode: "followup",
							fields: {
								action: "turn_started",
								index: event.index,
								remainingWindowMs: Math.round(event.remainingWindowMs),
							},
						});
						await recordActionCall(
							initialTurn.turn + event.index,
							"core.followup",
							"turn_started",
							{
								index: event.index,
								remainingWindowMs: Math.round(event.remainingWindowMs),
							},
						);
					},
					onTurnCompleted: async (event) => {
						runtimeLogger.log(
							`Follow-up turn ${event.index} completed (hasTranscript=${event.outcome.hasTranscript ? "1" : "0"}).`,
						);
						await perf.recordPhase({
							phase: "followup",
							status: "ok",
							turn: event.outcome.turn,
							mode: "followup",
							fields: {
								action: "turn_completed",
								index: event.index,
								hasTranscript: event.outcome.hasTranscript,
							},
						});
						await recordActionResult(event.outcome.turn, "core.followup", "turn_completed", {
							index: event.index,
							hasTranscript: event.outcome.hasTranscript,
						});
					},
					onWindowClosed: async (event) => {
						runtimeLogger.log(`Follow-up window closed (${event.reason}).`);
						await perf.recordPhase({
							phase: "followup",
							status: "ok",
							turn: event.lastTurn,
							mode: "followup",
							fields: {
								action: "window_closed",
								reason: event.reason,
								executedTurns: event.executedTurns,
							},
						});
						await recordActionResult(event.lastTurn, "core.followup", "window_closed", {
							reason: event.reason,
							executedTurns: event.executedTurns,
						});
					try {
						await playConversationClosedCue();
					} catch (err) {
						runtimeLogger.error("Follow-up close cue error:", err);
					}
				},
			},
		});

		if (!followupResult.opened) return;
		if (followupResult.closeReason === "error") {
			runtimeLogger.error("Follow-up loop closed on turn error.");
		}
	};

	return {
		onTrigger,
		onTextIngress: runTextIngressTurn,
	};
}

function resolveResponseService(env: NodeJS.ProcessEnv) {
	try {
		return createResponseService({ env });
	} catch (err) {
		if (isResponseError(err)) {
			sttTurnLogger.error(`LLM response disabled (${err.code}): ${err.message}`);
		} else {
			sttTurnLogger.error("Failed to initialize LLM response service:", err);
		}
		return null;
	}
}

function resolveHomeAssistantService(env: NodeJS.ProcessEnv) {
	try {
		const settings = resolveSettings(env).ha;
		return createHomeAssistantService({
			env,
			settings: {
				enabled: settings.enabled,
				timeoutMs: settings.timeoutMs,
			},
		});
	} catch (err) {
		if (err instanceof Error) {
			sttTurnLogger.error(`Home Assistant integration disabled: ${err.message}`);
		} else {
			sttTurnLogger.error("Home Assistant integration disabled:", err);
		}
		return null;
	}
}

function resolveHomeAssistantRouterConfig(env: NodeJS.ProcessEnv) {
	try {
		const settings = resolveSettings(env).ha;
		return resolveHomeAssistantConfig(env, {
			enabled: settings.enabled,
			timeoutMs: settings.timeoutMs,
		});
	} catch {
		return null;
	}
}

function isResponseError(err: unknown): err is ResponseErrorLike {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof (err as { code: unknown }).code === "string" &&
		"message" in err &&
		typeof (err as { message: unknown }).message === "string"
	);
}

function resolveCommandFailureSpeech(input: {
	transcript: string;
	code: string;
	message: string;
	details?: Record<string, unknown>;
}): {
	text: string;
	language: "en" | "ru";
} {
	const fallbackLanguage: "en" | "ru" = /[А-Яа-яЁё]/u.test(input.transcript) ? "ru" : "en";
	const detailText = typeof input.details?.assistantText === "string" ? input.details.assistantText.trim() : "";
	const detailLanguage = input.details?.language === "ru" || input.details?.language === "en" ? input.details.language : undefined;
	if (detailText) {
		return {
			text: detailText,
			language: detailLanguage ?? fallbackLanguage,
		};
	}

	if (input.code === "POLICY_SCOPE_DENIED" || input.code === "IDEMPOTENCY_REPLAY") {
		return {
			text:
				fallbackLanguage === "ru"
					? "[ru] Действие отклонено политикой безопасности."
					: "[en] That action was blocked by policy.",
			language: fallbackLanguage,
		};
	}

	if (input.code === "SCHEMA_INVALID") {
		return {
			text:
				fallbackLanguage === "ru"
					? "[ru] Нужен корректный идентификатор устройства или сцены."
					: "[en] I need a valid light or scene identifier for that action.",
			language: fallbackLanguage,
		};
	}

	return {
		text:
			fallbackLanguage === "ru"
				? `[ru] Не удалось выполнить команду (${input.code}).`
				: `[en] I couldn't execute that command (${input.code}).`,
		language: fallbackLanguage,
	};
}

function resolveContextKernelPrompt(env: NodeJS.ProcessEnv): string {
	const override = env.HERZEN_CONTEXT_KERNEL_PROMPT?.trim();
	if (override) return override;
	return "You are Herzen, a local voice assistant. Be concise, safe, and practical.";
}

function normalizeContextLanguage(rawLanguage: string | undefined): "en" | "ru" | undefined {
	const normalized = rawLanguage?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized.startsWith("ru")) return "ru";
	if (normalized.startsWith("en")) return "en";
	return undefined;
}

interface StartupRuntimeConfig {
	triggerMode: TriggerMode;
	recordingMode: RecordingMode;
	recordEnvOverrides: NodeJS.ProcessEnv;
	interactiveMode: boolean;
}

type BootPhase =
	| "BOOT_CONFIG_LOAD"
	| "BOOT_CONFIG_VALIDATE"
	| "BOOT_DEP_INIT"
	| "BOOT_RUNTIME_START"
	| "BOOT_READY";

class StartupFatalError extends Error {
	readonly phase: BootPhase;
	readonly code: string;
	readonly remediation: string;

	constructor(phase: BootPhase, code: string, remediation: string, cause?: unknown) {
		super(code);
		this.phase = phase;
		this.code = code;
		this.remediation = remediation;
		if (cause !== undefined) {
			(this as Error & { cause?: unknown }).cause = cause;
		}
	}
}

function isTruthy(raw: string | undefined): boolean {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return false;
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function profileSupportsVoice(profile: RuntimeProfile): boolean {
	return profile === "voice" || profile === "hybrid";
}

function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

async function resolveStartupRuntimeConfig(baseEnv: NodeJS.ProcessEnv): Promise<StartupRuntimeConfig> {
	const interactiveMode = isTruthy(baseEnv.HERZEN_STARTUP_INTERACTIVE) && Boolean(process.stdin.isTTY);
	const recordingMode = await resolveInitialRecordingModeInteractive({
		rawMode: baseEnv.HERZEN_RECORD_MODE,
		isInteractive: interactiveMode,
	});
	const recordEnvOverrides: NodeJS.ProcessEnv = {
		HERZEN_RECORD_MODE: recordingMode,
	};
	if (recordingMode === "adaptive") {
		const adaptiveMaxSeconds = await resolveInitialAdaptiveMaxSecondsInteractive({
			rawMaxSeconds: baseEnv.HERZEN_RECORD_MAX_SECONDS,
			defaultMaxSeconds: 60,
			isInteractive: interactiveMode,
		});
		recordEnvOverrides.HERZEN_RECORD_MAX_SECONDS = String(adaptiveMaxSeconds);
	}

	const triggerMode = await resolveInitialTriggerModeInteractive({
		rawMode: baseEnv.HERZEN_TRIGGER_MODE,
		isInteractive: interactiveMode,
	});
	recordEnvOverrides.HERZEN_TRIGGER_MODE = triggerMode;
	return {
		triggerMode,
		recordingMode,
		recordEnvOverrides,
		interactiveMode,
	};
}

function resolveSessionSettings(
	runtimeProfile: RuntimeProfile,
	triggerMode: TriggerMode,
	recordingMode: RecordingMode,
	env: NodeJS.ProcessEnv,
): SessionSettingsSnapshot {
	return {
		provider: env.HERZEN_RESPONSE_PROVIDER?.trim() || "ollama",
		model: env.HERZEN_OLLAMA_MODEL?.trim() || "unconfigured",
		temperature: resolveNumber(env.HERZEN_RESPONSE_TEMPERATURE, DEFAULT_RESPONSE_TEMPERATURE),
		responseTimeoutMs: resolvePositiveInteger(env.HERZEN_RESPONSE_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS),
		runtimeProfile,
		triggerMode,
		recordingMode,
		sttLanguageMode: env.HERZEN_STT_LANGUAGE?.trim() || "auto",
	};
}

function printStartupSummary(input: {
	sessionId: string;
	profile: RuntimeProfile;
	triggerMode: TriggerMode;
	recordingMode: RecordingMode;
	adaptiveMaxSeconds?: string;
	runtimeEnv: NodeJS.ProcessEnv;
	controlsPollMs: number;
	haEnabled: boolean;
	dataRootPath: string;
}): void {
	const responseProvider = input.runtimeEnv.HERZEN_RESPONSE_PROVIDER?.trim() || "ollama";
	const responseModel = input.runtimeEnv.HERZEN_OLLAMA_MODEL?.trim() || "unconfigured";
	const languageMode = input.runtimeEnv.HERZEN_STT_LANGUAGE?.trim() || "auto";
	process.stdout.write("Herzen Core\n");
	process.stdout.write(
		[
			`session=${shortSessionId(input.sessionId)}`,
			`profile=${input.profile}`,
			`trigger=${input.triggerMode}`,
			`recording=${input.recordingMode}${input.adaptiveMaxSeconds ? `:${input.adaptiveMaxSeconds}s` : ""}`,
			`response=${responseProvider}/${responseModel}`,
			`stt_language=${languageMode}`,
			`ha=${input.haEnabled ? "enabled" : "disabled"}`,
			`controls=ingress:${input.controlsPollMs}ms`,
			`data=${input.dataRootPath}`,
		].join("\n") + "\n",
	);
	process.stdout.write(`READY session=${shortSessionId(input.sessionId)} profile=${input.profile}\n`);
}

function controlCommandPolicyScope(command: ControlIngressCommand): string {
	if (command.command === "chat.send") return "chat:write";
	if (command.command === "runtime.get_status") return "runtime:read";
	return "runtime:write";
}

function controlCommandArgs(command: ControlIngressCommand): Record<string, unknown> {
	switch (command.command) {
		case "chat.send":
			return { text: command.text, source: command.source };
		case "runtime.set_profile":
			return { profile: command.profile };
		case "voice.trigger_once":
			return {};
		case "wakeword.set_enabled":
			return { enabled: command.enabled };
		case "runtime.get_status":
			return { includeDiagnostics: command.includeDiagnostics ?? false };
		default:
			return {};
	}
}

interface ControlCommandResult {
	ok: boolean;
	code?: string;
	message?: string;
	details?: Record<string, unknown>;
}

async function main(): Promise<void> {
	let startupPhase: BootPhase = "BOOT_CONFIG_LOAD";
	let startupConfig: StartupRuntimeConfig;
	let runtimeEnv: NodeJS.ProcessEnv;
	let runtimeSettings!: ReturnType<typeof resolveSettings>;
	let runtimeProfile = bootSettings.runtime.profile;
	let shuttingDown = false;

	try {
		startupConfig = await resolveStartupRuntimeConfig({
			...process.env,
			...runtimeSettingsEnvOverrides,
		});
		runtimeEnv = {
			...process.env,
			...runtimeSettingsEnvOverrides,
			...startupConfig.recordEnvOverrides,
		};

		startupPhase = "BOOT_CONFIG_VALIDATE";
		runtimeSettings = resolveSettings(runtimeEnv);
		runtimeProfile = runtimeSettings.runtime.profile;

		await updateCoreStatus({
			profile: runtimeProfile,
			coreState: "starting",
			triggerState: "disabled",
			wakewordState: startupConfig.triggerMode === "wakeword" ? "ready" : "disabled",
			sttState: "ready",
			ttsState: "ready",
		});

		startupPhase = "BOOT_DEP_INIT";
		controlEventStore = createControlEventStore({
			controlDir,
			sessionId: runtimeSessionId,
		});
		if (runtimeSettings.logging.retentionEnabled && runtimeSettings.logging.retentionPruneOnStartup) {
			try {
				const pruneResult = await pruneLogDirectory(logsDir, {
					enabled: true,
					maxBytes: runtimeSettings.logging.retentionMaxBytes,
					maxAgeDays: runtimeSettings.logging.retentionMaxAgeDays,
				});
				coreLogger.info("core.log_retention_pruned", {
					scannedFiles: pruneResult.scannedFiles,
					removedFiles: pruneResult.removedFiles.length,
					totalBytesBefore: pruneResult.totalBytesBefore,
					totalBytesAfter: pruneResult.totalBytesAfter,
				});
			} catch (err) {
				coreLogger.warn("core.log_retention_failed", {
					message: err instanceof Error ? err.message : "Unknown retention error.",
				});
			}
		}
		dialogJournal = createDialogJournal({
			conversationsDir,
			enabled: runtimeSettings.logging.dialogEnabled,
			markdownEnabled: runtimeSettings.logging.dialogMarkdownEnabled,
			sessionId: runtimeSessionId,
		});
		await dialogJournal.recordSessionStarted(
			resolveSessionSettings(runtimeProfile, startupConfig.triggerMode, startupConfig.recordingMode, runtimeEnv),
		);
		const triggerHandler = createHandleTrigger(
			startupConfig.recordingMode,
			startupConfig.triggerMode,
			runtimeEnv,
			dialogJournal,
			perfJournal,
		);

		const ingressReader = createControlIngressReader(controlDir);
		const controlsPollMs = resolvePositiveInteger(runtimeEnv.HERZEN_CONTROL_POLL_MS, 250);
		let ingressPollInFlight = false;
		let wakewordEnabled = startupConfig.triggerMode === "wakeword";
		let voiceTriggerSource: ReturnType<typeof createTriggerSource> | null = null;
		let voiceTriggerLoopTask: Promise<void> | null = null;
		let voiceTriggerLoopRunning = false;
		let voiceTurnInFlight = false;
		let controlTurnCounter = 0;
		let profileTransitionQueue = Promise.resolve();

		const appendExecutionEvent = async (
			event: Omit<ExecutionEventV1, "schemaVersion" | "eventId" | "sessionId" | "ts">,
		): Promise<void> => {
			try {
				await controlEventStore?.appendExecution({
					schemaVersion: "execution.v1",
					eventId: randomUUID(),
					sessionId: runtimeSessionId,
					ts: new Date().toISOString(),
					...event,
				});
			} catch (err) {
				coreLogger.warn("core.control_execution_write_failed", {
					message: err instanceof Error ? err.message : "Unknown control execution write error.",
				});
			}
		};

		const appendControlCommand = async (input: {
			command: ControlIngressCommand;
			turn: number;
			traceId?: string;
		}): Promise<string> => {
			const commandId = randomUUID();
			try {
				await controlEventStore?.appendCommand({
					schemaVersion: "command.v1",
					commandId,
					sessionId: runtimeSessionId,
					turn: input.turn,
					laneKey: `session:${runtimeSessionId}:control`,
					name: input.command.command,
					args: controlCommandArgs(input.command),
					policyScope: controlCommandPolicyScope(input.command),
					idempotencyKey: `${runtimeSessionId}:${input.command.ingressId}:${input.command.command}`,
					traceId: input.traceId,
					ts: new Date().toISOString(),
				});
			} catch (err) {
				coreLogger.warn("core.control_command_write_failed", {
					message: err instanceof Error ? err.message : "Unknown control command write error.",
				});
			}
			return commandId;
		};

		const markDegraded = async (code: string, message: string): Promise<void> => {
			await updateCoreStatus({
				coreState: "degraded",
				lastError: {
					code,
					message,
					ts: new Date().toISOString(),
				},
			});
		};

		const markReady = async (): Promise<void> => {
			await updateCoreStatus({
				coreState: "ready",
				lastError: undefined,
			});
		};

		const runVoiceTurn = async (
			origin: "trigger" | "control",
			traceId?: string,
		): Promise<ControlCommandResult> => {
			if (voiceTurnInFlight) {
				return {
					ok: false,
					code: "VOICE_BUSY",
					message: "Voice capture already in progress.",
				};
			}
			voiceTurnInFlight = true;
			try {
				await triggerHandler.onTrigger();
				if (origin === "control") {
					coreLogger.info("core.voice_trigger_once_applied", { traceId });
				}
				return { ok: true };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await markDegraded("VOICE_TURN_FAILED", message);
				triggerLogger.error("trigger.turn_failed", { message, traceId, origin });
				return {
					ok: false,
					code: "VOICE_TURN_FAILED",
					message,
				};
			} finally {
				voiceTurnInFlight = false;
			}
		};

		const stopVoiceTriggerLoop = async (): Promise<void> => {
			voiceTriggerLoopRunning = false;
			const activeSource = voiceTriggerSource;
			voiceTriggerSource = null;
			try {
				await activeSource?.stop();
			} catch (err) {
				triggerLogger.warn("trigger.stop_failed", {
					message: err instanceof Error ? err.message : String(err),
				});
			}
			try {
				await voiceTriggerLoopTask;
			} catch {
				// Loop failures are already reflected through structured status updates.
			} finally {
				voiceTriggerLoopTask = null;
			}
		};

		const startVoiceTriggerLoop = async (): Promise<ControlCommandResult> => {
			if (voiceTriggerLoopRunning) {
				return { ok: true };
			}
			if (!profileSupportsVoice(runtimeProfile)) {
				await updateCoreStatus({
					triggerState: "disabled",
					wakewordState: startupConfig.triggerMode === "wakeword" ? "disabled" : "disabled",
				});
				return { ok: true };
			}
			if (startupConfig.triggerMode === "wakeword" && !wakewordEnabled) {
				await updateCoreStatus({
					triggerState: "disabled",
					wakewordState: "disabled",
				});
				return { ok: true };
			}

			const source = createTriggerSource(startupConfig.triggerMode);
			try {
				await source.start();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await updateCoreStatus({
					triggerState: "error",
					wakewordState: startupConfig.triggerMode === "wakeword" ? "error" : "disabled",
				});
				await markDegraded("TRIGGER_START_FAILED", message);
				return {
					ok: false,
					code: "TRIGGER_START_FAILED",
					message,
				};
			}

			voiceTriggerSource = source;
			voiceTriggerLoopRunning = true;
			await updateCoreStatus({
				triggerState: "ready",
				wakewordState: startupConfig.triggerMode === "wakeword" ? "ready" : "disabled",
			});
			triggerLogger.info("trigger.loop_started", {
				mode: startupConfig.triggerMode,
				profile: runtimeProfile,
			});

			voiceTriggerLoopTask = (async () => {
				while (voiceTriggerLoopRunning) {
					try {
						await source.nextTrigger();
						if (!voiceTriggerLoopRunning) break;
						triggerLogger.info("trigger.received", {
							mode: startupConfig.triggerMode,
							profile: runtimeProfile,
						});
						const outcome = await runVoiceTurn("trigger");
						if (!outcome.ok) {
							await updateCoreStatus({
								triggerState: "error",
								wakewordState: startupConfig.triggerMode === "wakeword" ? "error" : "disabled",
							});
						}
					} catch (err) {
						if (!voiceTriggerLoopRunning) return;
						if (isTriggerError(err) && err.code === "SOURCE_CLOSED") {
							await updateCoreStatus({
								triggerState: "disabled",
								wakewordState: startupConfig.triggerMode === "wakeword" ? "disabled" : "disabled",
							});
							return;
						}
						const message = err instanceof Error ? err.message : String(err);
						triggerLogger.error("trigger.loop_error", {
							message,
							mode: startupConfig.triggerMode,
						});
						await updateCoreStatus({
							triggerState: "error",
							wakewordState: startupConfig.triggerMode === "wakeword" ? "error" : "disabled",
						});
						await markDegraded("TRIGGER_LOOP_FAILED", message);
						voiceTriggerLoopRunning = false;
						return;
					}
				}
			})();
			return { ok: true };
		};

		const applyProfileTransition = async (
			nextProfile: RuntimeProfile,
			reason: string,
		): Promise<ControlCommandResult> => {
			if (nextProfile === runtimeProfile) {
				return {
					ok: true,
					details: {
						profile: runtimeProfile,
						changed: false,
					},
				};
			}
			const previousProfile = runtimeProfile;
			if (!profileSupportsVoice(nextProfile)) {
				await stopVoiceTriggerLoop();
				runtimeProfile = nextProfile;
				await updateCoreStatus({
					profile: runtimeProfile,
					triggerState: "disabled",
					wakewordState: "disabled",
				});
				await markReady();
				await dialogJournal?.recordActionCall({
					turn: 0,
					integration: "core.runtime",
					operation: "profile.set",
					args: {
						from: previousProfile,
						to: runtimeProfile,
						reason,
					},
				});
				await dialogJournal?.recordActionResult({
					turn: 0,
					integration: "core.runtime",
					operation: "profile.set",
					result: {
						ok: true,
						profile: runtimeProfile,
					},
				});
				coreLogger.info("core.profile_changed", {
					from: previousProfile,
					to: runtimeProfile,
					reason,
				});
				return {
					ok: true,
					details: {
						profile: runtimeProfile,
						changed: true,
					},
				};
			}

			runtimeProfile = nextProfile;
			await updateCoreStatus({
				profile: runtimeProfile,
			});
			const startOutcome = await startVoiceTriggerLoop();
			if (!startOutcome.ok) {
				runtimeProfile = previousProfile;
				await updateCoreStatus({
					profile: runtimeProfile,
				});
				return startOutcome;
			}
			await markReady();
			await dialogJournal?.recordActionCall({
				turn: 0,
				integration: "core.runtime",
				operation: "profile.set",
				args: {
					from: previousProfile,
					to: runtimeProfile,
					reason,
				},
			});
			await dialogJournal?.recordActionResult({
				turn: 0,
				integration: "core.runtime",
				operation: "profile.set",
				result: {
					ok: true,
					profile: runtimeProfile,
				},
			});
			coreLogger.info("core.profile_changed", {
				from: previousProfile,
				to: runtimeProfile,
				reason,
			});
			return {
				ok: true,
				details: {
					profile: runtimeProfile,
					changed: true,
				},
			};
		};

		const enqueueProfileTransition = async (
			nextProfile: RuntimeProfile,
			reason: string,
		): Promise<ControlCommandResult> => {
			let outcome: ControlCommandResult = {
				ok: false,
				code: "PROFILE_TRANSITION_UNKNOWN",
				message: "Profile transition did not complete.",
			};
			profileTransitionQueue = profileTransitionQueue
				.then(async () => {
					outcome = await applyProfileTransition(nextProfile, reason);
				})
				.catch((err) => {
					outcome = {
						ok: false,
						code: "PROFILE_TRANSITION_FAILED",
						message: err instanceof Error ? err.message : String(err),
					};
				});
			await profileTransitionQueue;
			return outcome;
		};

		const applyControlCommand = async (command: Exclude<ControlIngressCommand, ChatIngressCommand>): Promise<ControlCommandResult> => {
			switch (command.command) {
				case "runtime.set_profile":
					return enqueueProfileTransition(command.profile, `ingress:${command.ingressId}`);
				case "voice.trigger_once":
					if (!profileSupportsVoice(runtimeProfile)) {
						return {
							ok: false,
							code: "VOICE_DISABLED_IN_PROFILE",
							message: `Voice is disabled in ${runtimeProfile} profile.`,
						};
					}
					return runVoiceTurn("control", command.traceId);
				case "wakeword.set_enabled":
					if (startupConfig.triggerMode !== "wakeword") {
						return {
							ok: false,
							code: "WAKEWORD_UNSUPPORTED",
							message: "Wakeword toggle is only available in wakeword trigger mode.",
						};
					}
					wakewordEnabled = command.enabled;
					if (!command.enabled) {
						await stopVoiceTriggerLoop();
						await updateCoreStatus({
							wakewordState: "disabled",
							triggerState: "disabled",
						});
					} else if (profileSupportsVoice(runtimeProfile)) {
						const startOutcome = await startVoiceTriggerLoop();
						if (!startOutcome.ok) return startOutcome;
					} else {
						await updateCoreStatus({
							wakewordState: "disabled",
							triggerState: "disabled",
						});
					}
					await dialogJournal?.recordActionCall({
						turn: 0,
						integration: "core.runtime",
						operation: "wakeword.set_enabled",
						args: {
							enabled: command.enabled,
						},
					});
					await dialogJournal?.recordActionResult({
						turn: 0,
						integration: "core.runtime",
						operation: "wakeword.set_enabled",
						result: {
							ok: true,
							enabled: command.enabled,
						},
					});
					return {
						ok: true,
						details: {
							enabled: command.enabled,
						},
					};
				case "runtime.get_status":
					return {
						ok: true,
						details: command.includeDiagnostics
							? {
									status: coreStatusWriter.snapshot(),
									runtime: {
										triggerMode: startupConfig.triggerMode,
										recordingMode: startupConfig.recordingMode,
										interactiveMode: startupConfig.interactiveMode,
									},
								}
							: {
									status: {
										profile: runtimeProfile,
										coreState: coreStatusWriter.snapshot().coreState,
									},
								},
					};
			}
		};

		const processControlCommand = async (command: ControlIngressCommand): Promise<void> => {
			if (command.sessionId !== runtimeSessionId) return;
			if (command.command === "chat.send") {
				await triggerHandler.onTextIngress(command);
				return;
			}

			const turn = ++controlTurnCounter;
			const commandId = await appendControlCommand({
				command,
				turn,
				traceId: command.traceId,
			});
			await appendExecutionEvent({
				turn,
				traceId: command.traceId,
				commandId,
				phase: "ingress_accepted",
				ok: true,
				details: {
					ackState: "accepted",
					command: command.command,
					ingressId: command.ingressId,
					source: command.source,
				},
			});
			await appendExecutionEvent({
				turn,
				traceId: command.traceId,
				commandId,
				phase: "command_started",
				ok: true,
				details: {
					command: command.command,
				},
			});
			const outcome = await applyControlCommand(command);
			if (outcome.ok) {
				await appendExecutionEvent({
					turn,
					traceId: command.traceId,
					commandId,
					phase: "command_succeeded",
					ok: true,
					details: {
						command: command.command,
						...(outcome.details ?? {}),
					},
				});
				await appendExecutionEvent({
					turn,
					traceId: command.traceId,
					commandId,
					phase: "ingress_processed",
					ok: true,
					details: {
						ackState: "applied",
						command: command.command,
						ingressId: command.ingressId,
						source: command.source,
						...(outcome.details ?? {}),
					},
				});
				return;
			}

			await appendExecutionEvent({
				turn,
				traceId: command.traceId,
				commandId,
				phase: "command_failed",
				ok: false,
				code: outcome.code ?? "CONTROL_COMMAND_FAILED",
				message: outcome.message ?? "Control command failed.",
				details: {
					command: command.command,
					...(outcome.details ?? {}),
				},
			});
			await appendExecutionEvent({
				turn,
				traceId: command.traceId,
				commandId,
				phase: "ingress_processed",
				ok: false,
				code: outcome.code ?? "CONTROL_COMMAND_FAILED",
				message: outcome.message ?? "Control command failed.",
				details: {
					ackState: "failed",
					command: command.command,
					ingressId: command.ingressId,
					source: command.source,
					...(outcome.details ?? {}),
				},
			});
		};

		const pollIngress = async (): Promise<void> => {
			if (ingressPollInFlight) return;
			ingressPollInFlight = true;
			try {
				const commands = await ingressReader.poll();
				for (const command of commands) {
					await processControlCommand(command);
				}
			} catch (err) {
				coreLogger.warn("core.control_ingress_poll_failed", {
					message: err instanceof Error ? err.message : "Unknown ingress poll failure.",
				});
			} finally {
				ingressPollInFlight = false;
			}
		};

		stopRuntime = async () => {
			await stopVoiceTriggerLoop();
		};

		startupPhase = "BOOT_RUNTIME_START";
		await perfJournal.recordPhase({
			phase: "runtime",
			status: "started",
			mode: "runtime",
			fields: {
				triggerMode: startupConfig.triggerMode,
				recordingMode: startupConfig.recordingMode,
				profile: runtimeProfile,
				sampleIntervalMs: perfSampleIntervalMs,
			},
		});
		await perfJournal.recordProcessSample(collectProcessSample());
		startProcessSampling();
		startStatusHeartbeat();
		startIngressPolling(pollIngress, controlsPollMs);

		const startupProfileOutcome = await enqueueProfileTransition(runtimeProfile, "startup");
		if (!startupProfileOutcome.ok) {
			await markDegraded(
				startupProfileOutcome.code ?? "PROFILE_STARTUP_FAILED",
				startupProfileOutcome.message ?? "Failed to start runtime profile.",
			);
		}

		await updateCoreStatus({
			profile: runtimeProfile,
			coreState: startupProfileOutcome.ok ? "ready" : "degraded",
			sttState: "ready",
			ttsState: "ready",
		});
		startupPhase = "BOOT_READY";

		printStartupSummary({
			sessionId: runtimeSessionId,
			profile: runtimeProfile,
			triggerMode: startupConfig.triggerMode,
			recordingMode: startupConfig.recordingMode,
			adaptiveMaxSeconds: startupConfig.recordEnvOverrides.HERZEN_RECORD_MAX_SECONDS,
			runtimeEnv,
			controlsPollMs,
			haEnabled: runtimeSettings.ha.enabled,
			dataRootPath: dataRoot,
		});

		const requestShutdown = (signal: string) => {
			if (shuttingDown) return;
			shuttingDown = true;
			coreLogger.info("core.shutdown_requested", { signal, message: "Shutting down." });
			void flushAndExit(0);
		};

		process.on("SIGINT", () => requestShutdown("SIGINT"));
		process.on("SIGTERM", () => requestShutdown("SIGTERM"));
	} catch (err) {
		if (err instanceof StartupFatalError) {
			process.stderr.write(
				`FATAL phase=${err.phase} code=${err.code} remediation="${err.remediation}"\n`,
			);
		} else {
			const code = "BOOT_FAILED";
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`FATAL phase=${startupPhase} code=${code} remediation="Check runtime settings and logs."\n`,
			);
			await updateCoreStatus({
				coreState: "degraded",
				lastError: {
					code,
					message,
					ts: new Date().toISOString(),
				},
			});
		}
		await flushAndExit(1);
	}
}

void main();

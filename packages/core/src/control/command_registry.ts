import type { PolicyDecisionCode, PolicyGate } from "./policy_gate.js";

export interface CommandExecutionContext {
	sessionId: string;
	turn: number;
	laneKey: string;
	traceId?: string;
	languageHint?: string;
}

export interface CommandRequest {
	name: string;
	args: Record<string, unknown>;
	policyScope: string;
	idempotencyKey: string;
}

export interface CommandValidationSuccess<TArgs extends object> {
	ok: true;
	args: TArgs;
}

export interface CommandValidationFailure {
	ok: false;
	code: string;
	message: string;
}

export type CommandValidationResult<TArgs extends object> =
	| CommandValidationSuccess<TArgs>
	| CommandValidationFailure;

export interface CommandHandlerSuccess<TResult = unknown> {
	ok: true;
	result: TResult;
}

export interface CommandHandlerFailure {
	ok: false;
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

export type CommandHandlerResult<TResult = unknown> =
	| CommandHandlerSuccess<TResult>
	| CommandHandlerFailure;

export interface CommandDefinition<
	TArgs extends object = Record<string, unknown>,
	TResult = unknown,
> {
	name: string;
	policyScope: string;
	validateArgs: (args: Record<string, unknown>) => CommandValidationResult<TArgs>;
	execute: (args: TArgs, context: CommandExecutionContext) => Promise<CommandHandlerResult<TResult>>;
}

export type CommandFailurePhase = "validation" | "policy" | "execution";

export interface CommandExecutionSuccess<TResult = unknown> {
	ok: true;
	name: string;
	policyScope: string;
	result: TResult;
}

export interface CommandExecutionFailure {
	ok: false;
	name: string;
	policyScope: string;
	phase: CommandFailurePhase;
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

export type CommandExecutionResult<TResult = unknown> =
	| CommandExecutionSuccess<TResult>
	| CommandExecutionFailure;

export interface CommandRegistry {
	register: <TArgs extends object, TResult>(definition: CommandDefinition<TArgs, TResult>) => void;
	listCommandNames: () => string[];
	execute: (
		request: CommandRequest,
		context: CommandExecutionContext,
	) => Promise<CommandExecutionResult>;
}

export interface CreateCommandRegistryOptions {
	policyGate: PolicyGate;
}

export function createCommandRegistry(options: CreateCommandRegistryOptions): CommandRegistry {
	interface StoredCommandDefinition {
		name: string;
		policyScope: string;
		validateArgs: (args: Record<string, unknown>) => CommandValidationResult<object>;
		execute: (
			args: object,
			context: CommandExecutionContext,
		) => Promise<CommandHandlerResult<unknown>>;
	}
	const definitions = new Map<string, StoredCommandDefinition>();

	const policyFailure = (
		name: string,
		policyScope: string,
		code: PolicyDecisionCode,
		message: string,
	): CommandExecutionFailure => ({
		ok: false,
		name,
		policyScope,
		phase: "policy",
		code,
		message,
	});

		return {
			register: (definition) => {
				definitions.set(definition.name, {
					name: definition.name,
					policyScope: definition.policyScope,
					validateArgs: (args) =>
						definition.validateArgs(args) as unknown as CommandValidationResult<object>,
					execute: (args, context) =>
						definition.execute(args as never, context) as Promise<CommandHandlerResult<unknown>>,
				});
			},
		listCommandNames: () => [...definitions.keys()],
		execute: async (request, context) => {
			const definition = definitions.get(request.name);
			if (!definition) {
				return {
					ok: false,
					name: request.name,
					policyScope: request.policyScope,
					phase: "validation",
					code: "COMMAND_UNKNOWN",
					message: `Unknown command "${request.name}".`,
				};
			}

			if (definition.policyScope !== request.policyScope) {
				return {
					ok: false,
					name: request.name,
					policyScope: definition.policyScope,
					phase: "validation",
					code: "POLICY_SCOPE_MISMATCH",
					message: `Command "${request.name}" must use scope "${definition.policyScope}".`,
				};
			}

			const validation = definition.validateArgs(request.args);
			if (!validation.ok) {
				return {
					ok: false,
					name: request.name,
					policyScope: definition.policyScope,
					phase: "validation",
					code: validation.code,
					message: validation.message,
				};
			}

			const policyDecision = options.policyGate.authorize({
				scope: definition.policyScope,
				idempotencyKey: request.idempotencyKey,
			});
			if (!policyDecision.ok && policyDecision.code && policyDecision.message) {
				return policyFailure(
					request.name,
					definition.policyScope,
					policyDecision.code,
					policyDecision.message,
				);
			}

			try {
				const executionResult = await definition.execute(validation.args, context);
				if (!executionResult.ok) {
					return {
						ok: false,
						name: request.name,
						policyScope: definition.policyScope,
						phase: "execution",
						code: executionResult.code,
						message: executionResult.message,
						details: executionResult.details,
					};
				}
					return {
						ok: true,
						name: request.name,
						policyScope: definition.policyScope,
						result: executionResult.result,
					};
			} catch (err) {
				return {
					ok: false,
					name: request.name,
					policyScope: definition.policyScope,
					phase: "execution",
					code: "EXECUTION_FAILED",
					message: err instanceof Error ? err.message : "Unknown command execution error.",
				};
			}
		},
	};
}

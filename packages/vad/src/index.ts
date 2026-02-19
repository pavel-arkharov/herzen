import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FRAME_SAMPLES = 512;
const DEFAULT_MODEL_FILENAME = "silero_vad.onnx";
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_STATE_DIMS = [2, 1, 128] as const;
const defaultDataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

export type VadConfigErrorCode = "CONFIG_INVALID" | "MODEL_MISSING" | "MODEL_UNREADABLE";
export type VadRuntimeErrorCode = "RUNTIME_MISSING" | "MODEL_INVALID" | "INFERENCE_FAILED";

interface VadConfigErrorOptions {
	cause?: unknown;
}

interface VadRuntimeErrorOptions {
	cause?: unknown;
}

export class VadConfigError extends Error {
	readonly code: VadConfigErrorCode;
	declare readonly cause?: unknown;

	constructor(code: VadConfigErrorCode, message: string, options?: VadConfigErrorOptions) {
		super(message);
		this.name = "VadConfigError";
		this.code = code;
		this.cause = options?.cause;
	}
}

export class VadRuntimeError extends Error {
	readonly code: VadRuntimeErrorCode;
	declare readonly cause?: unknown;

	constructor(code: VadRuntimeErrorCode, message: string, options?: VadRuntimeErrorOptions) {
		super(message);
		this.name = "VadRuntimeError";
		this.code = code;
		this.cause = options?.cause;
	}
}

export interface VadEngine {
	process: (frame: Float32Array) => Promise<number> | number;
	reset?: () => Promise<void> | void;
}

export interface VadSession {
	processFrame: (frame: Float32Array) => Promise<number>;
	reset: () => Promise<void>;
}

export interface VadSessionConfig {
	engine: VadEngine;
	frameSamples?: number;
}

export interface VadRuntimeConfig {
	modelPath: string;
}

export interface ResolveVadRuntimeConfigOptions {
	modelPath?: string;
	dataDir?: string;
	access?: (path: string, mode: number) => Promise<void>;
}

interface OrtTensorLike {
	data: unknown;
	dims: readonly number[];
}

interface OrtSessionLike {
	inputNames: string[];
	outputNames: string[];
	inputMetadata?: unknown;
	run: (feeds: Record<string, OrtTensorLike>) => Promise<Record<string, OrtTensorLike>>;
}

interface OrtTensorCtorLike {
	new (type: string, data: unknown, dims: readonly number[]): OrtTensorLike;
}

interface OrtModuleLike {
	InferenceSession: {
		create: (modelPath: string) => Promise<OrtSessionLike>;
	};
	Tensor: OrtTensorCtorLike;
}

export interface CreateSileroVadSessionOptions extends ResolveVadRuntimeConfigOptions {
	frameSamples?: number;
	sampleRate?: number;
	ort?: OrtModuleLike;
}

export interface CreateSileroVadEngineOptions {
	session: OrtSessionLike;
	ort: OrtModuleLike;
	frameSamples?: number;
	sampleRate?: number;
}

interface StateBinding {
	inputName: string;
	outputName: string;
	dims: number[];
}

export function resolveVadModelPath(
	rawModelPath = process.env.HERZEN_VAD_MODEL,
	rawDataDir = process.env.HERZEN_DATA_DIR,
): string {
	const modelPath = rawModelPath?.trim();
	if (modelPath) {
		return isAbsolute(modelPath) ? modelPath : resolve(modelPath);
	}
	if (rawModelPath !== undefined) {
		throw new VadConfigError("CONFIG_INVALID", "HERZEN_VAD_MODEL must be a non-empty path when provided.");
	}

	const dataRoot = resolveDataRoot(rawDataDir);
	return join(dataRoot, "models", DEFAULT_MODEL_FILENAME);
}

export async function resolveVadRuntimeConfig(
	options: ResolveVadRuntimeConfigOptions = {},
): Promise<VadRuntimeConfig> {
	const modelPath = resolveVadModelPath(options.modelPath, options.dataDir);
	await ensureModelReadable(modelPath, options.access ?? access);
	return { modelPath };
}

export async function createSileroVadSession(
	options: CreateSileroVadSessionOptions = {},
): Promise<VadSession> {
	const runtime = await resolveVadRuntimeConfig(options);
	const frameSamples = resolveFrameSamples(options.frameSamples);
	const sampleRate = resolveSampleRate(options.sampleRate);
	const ort = options.ort ?? (await loadOrtModule());

	let session: OrtSessionLike;
	try {
		session = await ort.InferenceSession.create(runtime.modelPath);
	} catch (err) {
		throw new VadRuntimeError("MODEL_INVALID", `Failed to load VAD model: ${runtime.modelPath}`, {
			cause: err,
		});
	}

	return createVadSession({
		frameSamples,
		engine: createSileroVadEngine({
			session,
			ort,
			frameSamples,
			sampleRate,
		}),
	});
}

export function createSileroVadEngine(options: CreateSileroVadEngineOptions): VadEngine {
	const frameSamples = resolveFrameSamples(options.frameSamples);
	const sampleRate = resolveSampleRate(options.sampleRate);
	const audioInputName = resolveAudioInputName(options.session.inputNames);
	const sampleRateInputName = options.session.inputNames.find((name) => isSampleRateInputName(name));
	const probabilityOutputName = resolveProbabilityOutputName(options.session.outputNames);
	const stateBindings = resolveStateBindings(options.session, {
		audioInputName,
		sampleRateInputName,
		probabilityOutputName,
	});
	const stateTensors = new Map<string, OrtTensorLike>();

	const initializeState = () => {
		stateTensors.clear();
		for (const binding of stateBindings) {
			stateTensors.set(binding.inputName, createZeroStateTensor(options.ort, binding.dims));
		}
	};
	initializeState();

	return {
		process: async (frame) => {
			const feeds: Record<string, OrtTensorLike> = {
				[audioInputName]: new options.ort.Tensor("float32", frame, [1, frameSamples]),
			};

			if (sampleRateInputName) {
				feeds[sampleRateInputName] = createSampleRateTensor(options.ort, sampleRate);
			}
			for (const binding of stateBindings) {
				const stateTensor = stateTensors.get(binding.inputName);
				if (!stateTensor) {
					throw new VadRuntimeError(
						"MODEL_INVALID",
						`Missing VAD state tensor for input "${binding.inputName}".`,
					);
				}
				feeds[binding.inputName] = stateTensor;
			}

			let outputs: Record<string, OrtTensorLike>;
			try {
				outputs = await options.session.run(feeds);
			} catch (err) {
				throw new VadRuntimeError("INFERENCE_FAILED", "VAD inference failed.", { cause: err });
			}

			const probabilityTensor = outputs[probabilityOutputName];
			if (!probabilityTensor) {
				throw new VadRuntimeError(
					"MODEL_INVALID",
					`VAD model output "${probabilityOutputName}" was not produced.`,
					);
				}

				for (const binding of stateBindings) {
					const nextState = outputs[binding.outputName];
					if (!nextState) {
						throw new VadRuntimeError(
							"MODEL_INVALID",
							`VAD model output "${binding.outputName}" was not produced.`,
						);
					}
					stateTensors.set(binding.inputName, nextState);
				}

				return readFirstTensorValue(probabilityTensor);
			},
			reset: () => {
				initializeState();
			},
		};
}

export function createVadSession(config: VadSessionConfig): VadSession {
	const frameSamples = resolveFrameSamples(config.frameSamples);

	return {
		async processFrame(frame: Float32Array): Promise<number> {
			if (frame.length !== frameSamples) {
				throw new Error(
					`Invalid VAD frame length ${frame.length}. Expected ${frameSamples} samples.`,
				);
			}

			const probability = await config.engine.process(frame);
			if (!Number.isFinite(probability)) {
				throw new Error(`VAD engine returned non-finite probability: ${String(probability)}.`);
			}
			if (probability < 0 || probability > 1) {
				throw new Error(`VAD engine returned out-of-range probability: ${probability}.`);
			}
			return probability;
		},

		async reset(): Promise<void> {
			await config.engine.reset?.();
		},
	};
}

function resolveFrameSamples(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_FRAME_SAMPLES;
	if (!Number.isInteger(raw) || raw <= 0) {
		throw new Error(
			`Invalid VAD frame sample size "${String(raw)}". Expected a positive integer.`,
		);
	}
	return raw;
}

function resolveSampleRate(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_SAMPLE_RATE;
	if (!Number.isInteger(raw) || raw <= 0) {
		throw new Error(`Invalid VAD sample rate "${String(raw)}". Expected a positive integer.`);
	}
	return raw;
}

function resolveDataRoot(rawDataDir: string | undefined): string {
	const dataDir = rawDataDir?.trim();
	if (!dataDir) return defaultDataRoot;
	return isAbsolute(dataDir) ? dataDir : resolve(dataDir);
}

async function ensureModelReadable(
	modelPath: string,
	accessFn: (path: string, mode: number) => Promise<void>,
): Promise<void> {
	try {
		await accessFn(modelPath, constants.R_OK);
	} catch (err) {
		if (isEnoent(err)) {
			throw new VadConfigError("MODEL_MISSING", `VAD model file not found: ${modelPath}`, {
				cause: err,
			});
		}

		throw new VadConfigError("MODEL_UNREADABLE", `VAD model file is not readable: ${modelPath}`, {
			cause: err,
		});
	}
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function resolveAudioInputName(inputNames: string[]): string {
	const preferred = inputNames.find((candidate) => {
		const normalized = candidate.toLowerCase();
		return (
			!isSampleRateInputName(candidate) &&
			!isLikelyStateInputName(candidate) &&
			(normalized === "input" || normalized.includes("input"))
		);
	});
	if (preferred) return preferred;

	const name = inputNames.find(
		(candidate) => !isSampleRateInputName(candidate) && !isLikelyStateInputName(candidate),
	);
	if (!name) {
		throw new VadRuntimeError("MODEL_INVALID", "Could not resolve VAD audio input name from model.");
	}
	return name;
}

function resolveProbabilityOutputName(outputNames: string[]): string {
	if (outputNames.length === 0) {
		throw new VadRuntimeError("MODEL_INVALID", "VAD model does not expose any outputs.");
	}

	const preferred = outputNames.find((name) => name.toLowerCase().includes("output"));
	return preferred ?? outputNames[0];
}

function isSampleRateInputName(name: string): boolean {
	const normalized = name.toLowerCase();
	return normalized === "sr" || normalized.includes("sample_rate");
}

function isLikelyStateInputName(name: string): boolean {
	const normalized = name.toLowerCase();
	if (normalized.includes("state")) return true;
	return normalized === "h" || normalized === "c";
}

function resolveStateBindings(
	session: OrtSessionLike,
	options: {
		audioInputName: string;
		sampleRateInputName: string | undefined;
		probabilityOutputName: string;
	},
): StateBinding[] {
	const stateInputNames = session.inputNames.filter((name) => {
		if (name === options.audioInputName) return false;
		if (name === options.sampleRateInputName) return false;
		return true;
	});
	if (stateInputNames.length === 0) return [];

	const stateOutputNames = session.outputNames.filter((name) => name !== options.probabilityOutputName);
	if (stateOutputNames.length === 0) {
		throw new VadRuntimeError(
			"MODEL_INVALID",
			"VAD model defines state inputs but does not provide state outputs.",
		);
	}

	const usedOutputs = new Set<string>();
	return stateInputNames.map((inputName, index) => {
		const outputName = resolveStateOutputName(inputName, {
			stateOutputNames,
			usedOutputs,
			stateIndex: index,
			stateCount: stateInputNames.length,
		});
		usedOutputs.add(outputName);
		return {
			inputName,
			outputName,
			dims: resolveStateDims(session, inputName),
		};
	});
}

function resolveStateOutputName(
	inputName: string,
	options: {
		stateOutputNames: string[];
		usedOutputs: Set<string>;
		stateIndex: number;
		stateCount: number;
	},
): string {
	const availableOutputs = options.stateOutputNames.filter((name) => !options.usedOutputs.has(name));
	const preferredCandidates = [`${inputName}n`, `${inputName}_n`, `${inputName}N`];
	for (const candidate of preferredCandidates) {
		const match = findCaseInsensitive(availableOutputs, candidate);
		if (match) return match;
	}

	const normalizedInput = inputName.toLowerCase();
	const prefixedMatch = availableOutputs.find((name) => {
		const normalizedName = name.toLowerCase();
		return normalizedName.startsWith(normalizedInput) && normalizedName.endsWith("n");
	});
	if (prefixedMatch) return prefixedMatch;

	if (options.stateOutputNames.length === options.stateCount) {
		const indexed = options.stateOutputNames[options.stateIndex];
		if (indexed && !options.usedOutputs.has(indexed)) return indexed;
	}

	if (availableOutputs.length === 1) return availableOutputs[0];

	throw new VadRuntimeError(
		"MODEL_INVALID",
		`Could not resolve VAD state output for input "${inputName}".`,
	);
}

function findCaseInsensitive(values: string[], needle: string): string | null {
	const target = needle.toLowerCase();
	return values.find((value) => value.toLowerCase() === target) ?? null;
}

function resolveStateDims(session: OrtSessionLike, stateInputName: string): number[] {
	const shape = resolveInputShape(session.inputMetadata, stateInputName);
	if (shape && shape.length > 0) {
		const dims = shape.map((value) =>
			typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1,
		);
		if (dims.every((value) => Number.isInteger(value) && value > 0)) {
			return dims;
		}
	}

	return [...DEFAULT_STATE_DIMS];
}

function resolveInputShape(inputMetadata: unknown, inputName: string): Array<number | string> | null {
	if (Array.isArray(inputMetadata)) {
		for (const entry of inputMetadata) {
			if (!entry || typeof entry !== "object") continue;
			const maybeNamed = entry as { name?: unknown; shape?: unknown; dimensions?: unknown };
			if (maybeNamed.name !== inputName) continue;
			const shape = maybeNamed.shape ?? maybeNamed.dimensions;
			if (Array.isArray(shape)) return shape as Array<number | string>;
		}
		return null;
	}

	if (inputMetadata && typeof inputMetadata === "object") {
		const record = inputMetadata as Record<string, unknown>;
		const entry = record[inputName];
		if (!entry || typeof entry !== "object") return null;
		const maybeEntry = entry as { shape?: unknown; dimensions?: unknown };
		const shape = maybeEntry.shape ?? maybeEntry.dimensions;
		if (Array.isArray(shape)) return shape as Array<number | string>;
	}

	return null;
}

function createZeroStateTensor(ort: OrtModuleLike, dims: readonly number[]): OrtTensorLike {
	const total = dims.reduce((acc, value) => acc * value, 1);
	return new ort.Tensor("float32", new Float32Array(total), dims);
}

function createSampleRateTensor(ort: OrtModuleLike, sampleRate: number): OrtTensorLike {
	return new ort.Tensor("int64", BigInt64Array.from([BigInt(sampleRate)]), []);
}

function readFirstTensorValue(tensor: OrtTensorLike): number {
	const data = tensor.data;
	if (ArrayBuffer.isView(data)) {
		const view = data as unknown as { length: number; [index: number]: number | bigint };
		if (view.length === 0) {
			throw new VadRuntimeError("MODEL_INVALID", "VAD model returned an empty tensor.");
		}
		const first = view[0];
		return typeof first === "bigint" ? Number(first) : Number(first);
	}
	if (Array.isArray(data) && data.length > 0) {
		return Number(data[0]);
	}
	throw new VadRuntimeError("MODEL_INVALID", "VAD model returned a tensor without readable numeric data.");
}

async function loadOrtModule(): Promise<OrtModuleLike> {
	try {
		const moduleName = "onnxruntime-node";
		const mod = await import(moduleName);
		return mod as unknown as OrtModuleLike;
	} catch (err) {
		throw new VadRuntimeError(
			"RUNTIME_MISSING",
			"onnxruntime-node is unavailable. Install workspace dependencies before using adaptive recording.",
			{ cause: err },
		);
	}
}

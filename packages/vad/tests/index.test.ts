import { describe, expect, it, vi } from "vitest";
import {
	VadConfigError,
	VadRuntimeError,
	createSileroVadEngine,
	createSileroVadSession,
	createVadSession,
	resolveVadModelPath,
	resolveVadRuntimeConfig,
} from "../src/index.js";

class FakeTensor {
	constructor(
		public readonly type: string,
		public readonly data: unknown,
		public readonly dims: readonly number[],
	) {}
}

describe("createVadSession", () => {
	it("uses default frame size and returns probability", async () => {
		const process = vi.fn(() => 0.6);
		const session = createVadSession({
			engine: { process },
		});
		const frame = new Float32Array(512);

		await expect(session.processFrame(frame)).resolves.toBe(0.6);
		expect(process).toHaveBeenCalledWith(frame);
	});

	it("rejects invalid frame length", async () => {
		const session = createVadSession({
			engine: { process: () => 0.3 },
		});

		await expect(session.processFrame(new Float32Array(160))).rejects.toThrow(
			"Invalid VAD frame length 160. Expected 512 samples.",
		);
	});

	it("supports custom frame size", async () => {
		const session = createVadSession({
			engine: { process: () => 0.4 },
			frameSamples: 160,
		});

		await expect(session.processFrame(new Float32Array(160))).resolves.toBe(0.4);
	});

	it("rejects out-of-range probability values", async () => {
		const session = createVadSession({
			engine: { process: () => 1.2 },
		});

		await expect(session.processFrame(new Float32Array(512))).rejects.toThrow(
			"VAD engine returned out-of-range probability: 1.2.",
		);
	});

	it("delegates reset to engine", async () => {
		const reset = vi.fn(async () => {});
		const session = createVadSession({
			engine: { process: () => 0.5, reset },
		});

		await session.reset();
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid frameSamples config", () => {
		expect(() =>
			createVadSession({
				engine: { process: () => 0.2 },
				frameSamples: 0,
			}),
		).toThrow('Invalid VAD frame sample size "0". Expected a positive integer.');
	});
});

describe("resolveVadModelPath", () => {
	it("defaults to data/models/silero_vad.onnx when HERZEN_VAD_MODEL is unset", () => {
		const modelPath = resolveVadModelPath(undefined, undefined);
		expect(modelPath.endsWith("/data/models/silero_vad.onnx")).toBe(true);
	});

	it("uses explicit absolute model path", () => {
		expect(resolveVadModelPath("/tmp/silero.onnx", undefined)).toBe("/tmp/silero.onnx");
	});

	it("resolves relative model path to absolute", () => {
		const modelPath = resolveVadModelPath("models/local-silero.onnx", undefined);
		expect(modelPath).toContain("/models/local-silero.onnx");
		expect(modelPath.startsWith("/")).toBe(true);
	});

	it("throws CONFIG_INVALID for empty HERZEN_VAD_MODEL", () => {
		expect(() => resolveVadModelPath("   ", undefined)).toThrowError(VadConfigError);
		expect(() => resolveVadModelPath("   ", undefined)).toThrow(
			expect.objectContaining({ code: "CONFIG_INVALID" }),
		);
	});

	it("uses HERZEN_DATA_DIR override for default path", () => {
		const modelPath = resolveVadModelPath(undefined, "/tmp/herzen-data");
		expect(modelPath).toBe("/tmp/herzen-data/models/silero_vad.onnx");
	});
});

describe("resolveVadRuntimeConfig", () => {
	it("returns runtime config when model is readable", async () => {
		const access = vi.fn(async () => {});

		await expect(
			resolveVadRuntimeConfig({
				modelPath: "/tmp/silero.onnx",
				access,
			}),
		).resolves.toEqual({ modelPath: "/tmp/silero.onnx" });
		expect(access).toHaveBeenCalled();
	});

	it("throws MODEL_MISSING when model file does not exist", async () => {
		const access = vi.fn(async () => {
			const err = new Error("missing");
			(err as Error & { code?: string }).code = "ENOENT";
			throw err;
		});

		await expect(
			resolveVadRuntimeConfig({
				modelPath: "/tmp/missing.onnx",
				access,
			}),
		).rejects.toMatchObject({
			name: "VadConfigError",
			code: "MODEL_MISSING",
		});
	});

	it("throws MODEL_UNREADABLE when model file cannot be read", async () => {
		const access = vi.fn(async () => {
			const err = new Error("permission denied");
			(err as Error & { code?: string }).code = "EACCES";
			throw err;
		});

		await expect(
			resolveVadRuntimeConfig({
				modelPath: "/tmp/protected.onnx",
				access,
			}),
		).rejects.toMatchObject({
			name: "VadConfigError",
			code: "MODEL_UNREADABLE",
		});
	});
});

describe("createSileroVadEngine", () => {
	it("runs inference with state tracking and reset", async () => {
		const returnedState = new FakeTensor("float32", new Float32Array([1]), [1, 1, 1]);
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				output: new FakeTensor("float32", new Float32Array([0.62]), [1, 1]),
				stateN: returnedState,
			})
			.mockResolvedValueOnce({
				output: new FakeTensor("float32", new Float32Array([0.28]), [1, 1]),
				stateN: returnedState,
			})
			.mockResolvedValueOnce({
				output: new FakeTensor("float32", new Float32Array([0.11]), [1, 1]),
				stateN: returnedState,
			});

		const engine = createSileroVadEngine({
			session: {
				inputNames: ["input", "state", "sr"],
				outputNames: ["output", "stateN"],
				run,
			},
			ort: {
				InferenceSession: { create: vi.fn() },
				Tensor: FakeTensor,
			},
			frameSamples: 512,
		});
		const frame = new Float32Array(512);

		await expect(engine.process(frame)).resolves.toBeCloseTo(0.62, 5);
		await expect(engine.process(frame)).resolves.toBeCloseTo(0.28, 5);

		const secondRunFeeds = run.mock.calls[1]?.[0] as Record<string, unknown>;
		expect(secondRunFeeds.state).toBe(returnedState);

		await engine.reset?.();
		await expect(engine.process(frame)).resolves.toBeCloseTo(0.11, 5);

		const thirdRunFeeds = run.mock.calls[2]?.[0] as Record<string, unknown>;
		expect(thirdRunFeeds.state).not.toBe(returnedState);
	});

	it("throws MODEL_INVALID when state output is missing", () => {
		expect(() =>
			createSileroVadEngine({
				session: {
					inputNames: ["input", "state"],
					outputNames: ["output"],
					run: vi.fn(),
				},
				ort: {
					InferenceSession: { create: vi.fn() },
					Tensor: FakeTensor,
				},
			}),
		).toThrowError(VadRuntimeError);
		expect(() =>
			createSileroVadEngine({
				session: {
					inputNames: ["input", "state"],
					outputNames: ["output"],
					run: vi.fn(),
				},
				ort: {
					InferenceSession: { create: vi.fn() },
					Tensor: FakeTensor,
				},
			}),
		).toThrow(expect.objectContaining({ code: "MODEL_INVALID" }));
	});

	it("supports h/c recurrent state inputs with hn/cn outputs", async () => {
		const run = vi.fn(async () => ({
			output: new FakeTensor("float32", new Float32Array([0.77]), [1, 1]),
			hn: new FakeTensor("float32", new Float32Array([1]), [2, 1, 64]),
			cn: new FakeTensor("float32", new Float32Array([1]), [2, 1, 64]),
		}));

		const engine = createSileroVadEngine({
			session: {
				inputNames: ["input", "sr", "h", "c"],
				outputNames: ["output", "hn", "cn"],
				inputMetadata: [
					{ name: "input", shape: ["batch", "sequence"] },
					{ name: "sr", shape: [] },
					{ name: "h", shape: [2, "batch", 64] },
					{ name: "c", shape: [2, "batch", 64] },
				],
				run,
			},
			ort: {
				InferenceSession: { create: vi.fn() },
				Tensor: FakeTensor,
			},
			frameSamples: 512,
		});

		await expect(engine.process(new Float32Array(512))).resolves.toBeCloseTo(0.77, 5);
		const feeds = run.mock.calls[0]?.[0] as Record<string, FakeTensor>;
		expect(feeds.sr.dims).toEqual([]);
		expect(feeds.h.dims).toEqual([2, 1, 64]);
		expect(feeds.c.dims).toEqual([2, 1, 64]);
	});
});

describe("createSileroVadSession", () => {
	it("creates a validated VAD session from model path and ort module", async () => {
		const run = vi.fn(async () => ({
			output: new FakeTensor("float32", new Float32Array([0.51]), [1, 1]),
		}));
		const create = vi.fn(async () => ({
			inputNames: ["input"],
			outputNames: ["output"],
			run,
		}));

		const session = await createSileroVadSession({
			modelPath: "/tmp/silero.onnx",
			access: async () => {},
			frameSamples: 160,
			ort: {
				InferenceSession: { create },
				Tensor: FakeTensor,
			},
		});

		await expect(session.processFrame(new Float32Array(160))).resolves.toBeCloseTo(0.51, 5);
		expect(create).toHaveBeenCalledWith("/tmp/silero.onnx");
	});
});

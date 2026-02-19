# Voice Activity Detection (VAD) in Herzen

This document describes the current `@herzen/vad` package and how it is used by adaptive recording.

---

## Role of VAD in Herzen

`@herzen/vad` provides local voice activity detection primitives used to decide when speech starts and ends.

The package is intentionally focused:

- resolve and validate VAD model runtime config
- run Silero VAD ONNX inference frame-by-frame
- expose a small session interface for probability-based endpointing

It does not record audio itself and does not own trigger, STT, or TTS orchestration.

---

## Backend and Dependency

Current backend:

- Silero VAD ONNX model
- `onnxruntime-node` runtime

Model path resolution:

- `HERZEN_VAD_MODEL` if set
- otherwise default: `<data-root>/models/silero_vad.onnx`
- `HERZEN_DATA_DIR` changes `<data-root>` when default pathing is used

---

## Public API

Key exports from `@herzen/vad`:

- `resolveVadModelPath(...)`
- `resolveVadRuntimeConfig(...)`
- `createSileroVadSession(...)`
- `createSileroVadEngine(...)`
- `createVadSession(...)`
- `VadConfigError`
- `VadRuntimeError`

Session behavior:

- `processFrame(frame: Float32Array): Promise<number>`
  - validates frame length
  - returns speech probability in `[0, 1]`
- `reset(): Promise<void>`

Default frame/sample settings:

- frame samples: `512`
- sample rate: `16000`

---

## Error Model

Configuration errors (`VadConfigError`):

- `CONFIG_INVALID`
- `MODEL_MISSING`
- `MODEL_UNREADABLE`

Runtime errors (`VadRuntimeError`):

- `RUNTIME_MISSING`
- `MODEL_INVALID`
- `INFERENCE_FAILED`

---

## Package Structure

```
packages/vad/
  src/index.ts
  tests/index.test.ts
```

---

## Integration

Current integration path:

1. `@herzen/audio` adaptive recorder calls `createSileroVadSession(...)`.
2. Raw PCM frames are converted to `Float32Array` frames.
3. VAD probability drives adaptive stop conditions (speech start, trailing silence, timeout, max cap).
4. `@herzen/core` orchestrates this by selecting recording mode and passing adaptive thresholds/env config.

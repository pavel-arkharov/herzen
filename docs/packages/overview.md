# Packages

This document lists the current packages in the Herzen monorepo.

**core**, **audio**, **stt**, **tts**, **vad**, and **wakeword** are currently implemented.
Other packages (integrations) will be added later.

---

## @herzen/audio

**Purpose**  
Low-level audio input and output utilities.

This package is responsible for:

- recording audio from the system microphone
- playing audio through system speakers
- emitting simple audio signals (beeps)

It intentionally:

- does not contain any assistant logic
- does not manage state
- does not know about wake words, STT, or TTS

The implementation currently wraps platform CLI tools (e.g. `sox`)
to keep things simple and debuggable.

Recording APIs:
- `recordWav(...)` for fixed-duration capture
- `recordAdaptiveWav(...)` for VAD-based adaptive endpointing

Current system dependency:
- `rec` and `play` from SoX

Adaptive recording dependency chain:
- `@herzen/vad` workspace package
- `onnxruntime-node` (via `@herzen/vad`)
- Silero VAD model file (`data/models/silero_vad.onnx` by default, or `HERZEN_VAD_MODEL`)

Future versions may:

- switch to native APIs (e.g. AVFoundation on macOS)
- expose streaming audio instead of files

---

## @herzen/core

**Purpose**  
The assistant “brain”.

This package:

- runs the main control loop
- coordinates audio recording and playback
- orchestrates STT via `@herzen/stt`
- will eventually host:
  - wake word routing
  - intent resolution
  - tool calling
  - memory access

The core package **does not** implement ML models directly.
Instead, it orchestrates other packages and services.

This keeps the system flexible and replaceable.

Current behavior (prototype):
- uses a trigger abstraction boundary (`core/src/trigger/*`)
- defaults to `stdin` trigger mode (manual Enter key)
- supports mode selection through `HERZEN_TRIGGER_MODE` (`stdin`, `wakeword`)
- includes a `wakeword` trigger adapter backed by `@herzen/wakeword` (still in-progress for next stretch)
- supports recording mode selection (`fixed` / `adaptive`) during interactive startup
- when adaptive mode is selected interactively, prompts for adaptive max length for the current run
- uses typed trigger-domain errors for control flow (`SOURCE_CLOSED`, `SOURCE_FAILED`)
- keeps a runtime-lifecycle `stdin` error listener in the trigger source, including during pipeline handling
- resolves default data output to repo-local `data/audio` independently of launch cwd
- supports `HERZEN_DATA_DIR` override (writes to `HERZEN_DATA_DIR/audio`)
- writes runtime structured logs to `data/logs/runtime.jsonl`
- writes STT turn logs to `data/logs/stt.jsonl`
- supports log level control through `HERZEN_LOG_LEVEL` (`info`, `warn`, `error`; default `info`)
- gates transcript persistence in logs with `HERZEN_LOG_TRANSCRIPT` (default disabled)
- sanitizes JSONL stream names and degrades logging sink failures to console warnings
- emits a short beep
- records audio to `data/audio` in two modes:
  - fixed: `HERZEN_RECORD_SECONDS` (default `3`)
  - adaptive: VAD endpointing driven by:
    - `HERZEN_RECORD_MIN_SECONDS` (default `1`)
    - `HERZEN_RECORD_MAX_SECONDS` (default `12`)
    - `HERZEN_RECORD_SILENCE_SECONDS` (default `0.7`)
    - `HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS` (default `4`)
    - `HERZEN_VAD_START_THRESHOLD` (default `0.55`)
    - `HERZEN_VAD_END_THRESHOLD` (default `0.35`)
    - `HERZEN_VAD_FRAME_SAMPLES` (default `512`)
- falls back to fixed recording for the current turn when adaptive config is invalid
- falls back to fixed recording for the current turn when adaptive runtime fails
- runs local STT transcription and logs per-turn telemetry (latency, duration, language mode, detected language, optional error code)
- plays the recording only when `HERZEN_PLAYBACK=1`
- speaks transcript-aware confirmation or a fallback message

---

## @herzen/stt

**Purpose**  
Local speech-to-text utilities.

This package is responsible for:

- converting local audio files to text via whisper.cpp CLI
- validating STT runtime/model configuration
- normalizing transcription output and error typing for callers
- generating per-file transcript documents (`txt` and `md`) via CLI/API helpers

Current input support:
- direct: `.wav`, `.mp3`, `.ogg`, `.flac`
- `.m4a`: converted to wav via local tools before transcription

CLI entrypoint:
- `pnpm transcribe:file -- "<audio-file>"`
- package binary: `herzen-stt` (built from `dist/cli.js`)

Default file-transcription output path:
- `data/transcribes/` under repo root when no explicit output path is provided

Current backend:
- `whisper.cpp` CLI (`whisper-cli` fallback on `PATH`)

Current environment surface:
- `HERZEN_WHISPER_MODEL` (required model file path)
- `HERZEN_WHISPER_BIN` (optional binary path override)
- `HERZEN_STT_LANGUAGE` (`auto`, `en`, `ru`; optional default mode)
- `HERZEN_STT_THREADS` (optional positive integer)

Optional local converter dependencies (for `.m4a` input):
- `ffmpeg` (preferred)
- `afconvert` (macOS fallback)

Current error model:
- `RUNTIME_MISSING`
- `MODEL_MISSING`
- `TRANSCRIBE_FAILED`
- `OUTPUT_PARSE_FAILED`

---

## @herzen/vad

**Purpose**  
Local voice activity detection primitives for adaptive endpointing.

This package is responsible for:

- resolving/validating local VAD model path and runtime configuration
- loading Silero VAD ONNX model sessions
- returning speech probability per audio frame
- managing recurrent VAD state tensors across frames

Current dependency:
- `onnxruntime-node`

Model path behavior:
- explicit override: `HERZEN_VAD_MODEL`
- default: `data/models/silero_vad.onnx` (uses `HERZEN_DATA_DIR` if set)

Current error model:
- config: `CONFIG_INVALID`, `MODEL_MISSING`, `MODEL_UNREADABLE`
- runtime: `RUNTIME_MISSING`, `MODEL_INVALID`, `INFERENCE_FAILED`

See detailed package notes in:
- `/Users/parkharo/Programming/herzen/docs/packages/vad.md`

---

## @herzen/tts

**Purpose**  
Text-to-speech output utilities.

This package is responsible for:

- converting text to speech via system voice APIs
- supporting multiple languages (English, Russian)
- detecting language from text or parsing explicit **leading** language tags

The implementation currently wraps macOS `say` command for simplicity and debuggability.

Current system dependency:
- macOS `say`

Future versions may:

- add higher-quality TTS engines (cloud or local)
- expose streaming speech instead of file-based output
- support more languages

---

## @herzen/wakeword

**Purpose**  
Local IPC client for the external wakeword daemon (`herzen-wake`).

This package is responsible for:

- connecting to a local Unix socket wakeword daemon
- waiting for daemon readiness before treating source as healthy
- parsing JSONL wakeword protocol messages
- delivering one detection per pending waiter (no queueing in v1)
- normalizing daemon/protocol/socket failures into typed wakeword client errors

Current environment surface:
- `HERZEN_WAKEWORD_SOCKET` (optional socket path override)
- `HERZEN_WAKEWORD_CONNECT_TIMEOUT_MS` (optional positive integer, default `3000`)
- `HERZEN_DATA_DIR` (optional data-root override used in default socket path resolution)

Current error model:
- `CONFIG_INVALID`
- `SOCKET_UNAVAILABLE`
- `PROTOCOL_ERROR`
- `SOURCE_CLOSED`
- `SOURCE_FAILED`

Shared protocol contract:
- `docs/architecture/wakeword_sidecar_contract.md`

---

## Planned (not yet implemented)

Future packages may include:

- integrations (home automation, notes, calendar)

These are intentionally absent for now.

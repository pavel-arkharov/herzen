# Packages

This document lists the current packages in the Herzen monorepo.

**core**, **audio**, **stt**, **tts**, **vad**, **wakeword**, **dialog**, and **integration-homeassistant** are currently implemented.

---

## @herzen/audio

**Purpose**  
Low-level audio input and output utilities.

This package is responsible for:

- recording audio from the system microphone
- playing audio through system speakers
- emitting simple audio cues (start/close tones)

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
- routes trigger events from `stdin` or wakeword source
- will eventually host:
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
- includes a `wakeword` trigger adapter backed by `@herzen/wakeword`
- defaults to adaptive recording mode at startup
- exposes fixed mode selection during interactive startup only when `HERZEN_ENABLE_FIXED_RECORDING=1`
- when adaptive mode is selected interactively, prompts for adaptive max length for the current run
- uses typed trigger-domain errors for control flow (`SOURCE_CLOSED`, `SOURCE_FAILED`)
- keeps a runtime-lifecycle `stdin` error listener in the trigger source, including during pipeline handling
- resolves default data output to repo-local `data/audio` independently of launch cwd
- supports `HERZEN_DATA_DIR` override (writes to `HERZEN_DATA_DIR/audio`)
- writes runtime structured logs to `data/logs/runtime.jsonl`
- writes STT turn logs to `data/logs/stt.jsonl`
- writes per-session conversation journals to:
  - `data/conversations/<sessionId>.jsonl` (machine-readable events)
  - `data/conversations/<sessionId>.md` (human-readable dialogue journal)
- supports log level control through `HERZEN_LOG_LEVEL` (`info`, `warn`, `error`; default `info`)
- gates transcript persistence in logs with `HERZEN_LOG_TRANSCRIPT` (default disabled)
- omits STT audio input path by default; include it only with `HERZEN_LOG_AUDIO_INPUT=1`
- supports dialog-journal toggle with `HERZEN_LOG_DIALOG` (default enabled)
- supports markdown-journal toggle with `HERZEN_LOG_DIALOG_MARKDOWN` (default enabled)
- sanitizes JSONL stream names and degrades logging sink failures to console warnings
- emits a short start cue once per triggered interaction
- when follow-up mode is enabled and a window closes, emits a distinct close cue
- records audio to `data/audio` in two modes:
  - fixed: `HERZEN_RECORD_SECONDS` (default `3`)
  - adaptive: VAD endpointing driven by:
    - `HERZEN_RECORD_MIN_SECONDS` (default `1`)
    - `HERZEN_RECORD_MAX_SECONDS` (default `60`)
    - `HERZEN_RECORD_SILENCE_SECONDS` (default `0.7`)
    - `HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS` (default `4`)
    - `HERZEN_VAD_START_THRESHOLD` (default `0.55`)
    - `HERZEN_VAD_END_THRESHOLD` (default `0.35`)
    - `HERZEN_VAD_FRAME_SAMPLES` (default `512`)
- falls back to fixed recording for the current turn when adaptive config is invalid
- falls back to fixed recording for the current turn when adaptive runtime fails
- runs local STT transcription and logs per-turn telemetry (latency, duration, language mode, detected language, optional error code)
- keeps an in-memory bounded context window for recent turns and injects it into LLM requests
  - `HERZEN_CONTEXT_ENABLED` (default `1`)
  - `HERZEN_CONTEXT_MAX_TURNS` (default `6`)
  - `HERZEN_CONTEXT_MAX_CHARS` (default `4000`)
- supports bounded conversational follow-up mode (default disabled):
  - `HERZEN_FOLLOWUP_ENABLED` (default `0`)
  - `HERZEN_FOLLOWUP_WINDOW_SECONDS` (default `8`, per-turn silence wait budget)
  - `HERZEN_FOLLOWUP_MAX_TURNS` (default `3`)
  - `HERZEN_FOLLOWUP_STOP_PHRASES` (optional CSV, normalized exact match)
  - follow-up closes on timeout, no speech, stop phrase, max turns, or turn error
- routes deterministic Home Assistant actions before LLM generation when `HERZEN_HA_ENABLED=1`
  - light actions: `light.turn_on`, `light.turn_off`
  - scene actions: `scene.turn_on`
  - if no HA intent matches, falls through to `@herzen/dialog`
- appends session-scoped conversation events (`session_started`, `user_utterance`, `assistant_utterance`, action placeholders, `error`, `session_ended`)
- plays the recording only when `HERZEN_PLAYBACK=1`
- speaks model-generated reply text via `@herzen/dialog` or a fallback message

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

- converting text to speech via local provider adapters
- supporting multiple languages (English, Russian)
- detecting language from text or parsing explicit **leading** language tags

Current implemented providers:

- `say` (default, macOS built-in)
- `piper` (local CLI synthesis with EN/RU model selection)
- `xtts` sidecar client (`POST /synthesize` to a local HTTP endpoint)

Provider/fallback environment surface:

- `HERZEN_TTS_PROVIDER` (`say`, `piper`, `xtts`)
- `HERZEN_TTS_FALLBACK_PROVIDER` (default `say`)
- `HERZEN_TTS_PIPER_MODEL_EN` (absolute path to EN `.onnx`)
- `HERZEN_TTS_PIPER_MODEL_RU` (absolute path to RU `.onnx`)
- `HERZEN_TTS_PIPER_CONFIG_EN` (optional path to EN `.onnx.json`)
- `HERZEN_TTS_PIPER_CONFIG_RU` (optional path to RU `.onnx.json`)
- `HERZEN_TTS_RATE_SCALE` (optional Piper `--length_scale`)
- `HERZEN_TTS_NOISE_SCALE` (optional Piper `--noise_scale`)
- `HERZEN_TTS_NOISE_W` (optional Piper `--noise_w`)
- `HERZEN_TTS_XTTS_ENDPOINT` (default `http://127.0.0.1:8020`)
- `HERZEN_TTS_XTTS_TIMEOUT_MS` (default `12000`)
- `HERZEN_TTS_XTTS_VOICE_PROFILE` (default `default`)
- `HERZEN_ALLOW_REMOTE_TTS` (default disabled; endpoint must be loopback unless explicitly overridden)

Expected local Piper model layout:
- `data/models/tts/piper/en/...`
- `data/models/tts/piper/ru/...`

Current system dependency:
- macOS `say`
- local playback tool (`play` from SoX, `afplay` fallback)

Future versions may:

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

---

## @herzen/integration-homeassistant

**Purpose**  
Deterministic local Home Assistant command adapter.

This package is responsible for:

- turning transcript text into explicit Home Assistant service calls
- enforcing allowlisted entity scope (no free-form entity execution)
- mapping room/scene aliases to HA entity IDs
- returning structured action results for journaling and TTS feedback

Current supported operations:

- `light.turn_on`
- `light.turn_off`
- `scene.turn_on`

Current environment surface:

- `HERZEN_HA_ENABLED` (`0/1`, default `0`)
- `HERZEN_HA_BASE_URL` or `HERZEN_HA_BASE_URL_FILE` or `HERZEN_HA_SECRETS_DIR/base_url`
- `HERZEN_HA_TOKEN` or `HERZEN_HA_TOKEN_FILE` or `HERZEN_HA_SECRETS_DIR/token`
- `HERZEN_HA_TIMEOUT_MS` (default `5000`)
- `HERZEN_HA_ALLOWED_LIGHTS` (CSV of `light.*`)
- `HERZEN_HA_LIGHT_ALIASES` (CSV `alias=light.a|light.b`)
- `HERZEN_HA_SCENE_ALIASES` (CSV `alias=scene.x`)
- `HERZEN_HA_DEFAULT_LIGHT` (single fallback light)

Security behavior:

- token files require owner-only permissions (`chmod 600`) on Unix-like systems
- inline secrets are allowed but file-based secrets are recommended

Operational behavior:

- one transcript currently maps to one action
- chaining/multi-action execution in a single utterance is not implemented yet

See detailed usage and setup in:
- `/Users/parkharo/Programming/herzen/docs/packages/integration-homeassistant.md`

Current error model:
- `CONFIG_INVALID`
- `SOCKET_UNAVAILABLE`
- `PROTOCOL_ERROR`
- `SOURCE_CLOSED`
- `SOURCE_FAILED`

Shared protocol contract:
- `docs/architecture/wakeword_sidecar_contract.md`

Daemon repository:
- <https://github.com/pavel-arkharov/herzen-wake>

---

## @herzen/dialog

**Purpose**  
Local assistant reply generation boundary (text-in, text-out).

This package is responsible for:

- validating response-runtime configuration
- exposing a stable response-service interface for core orchestration
- defining provider boundary types for local LLM integrations

Current status:

- typed provider contract and error model are implemented
- Ollama provider is implemented (`POST /api/chat`, non-streaming)
- optional short-term conversation context is injected before the current user transcript
- core STT-success path consumes `@herzen/dialog` and speaks model reply text

Current provider:

- `ollama` (local HTTP runtime)

Current environment surface:

- `HERZEN_RESPONSE_PROVIDER` (default `ollama`)
- `HERZEN_OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `HERZEN_OLLAMA_MODEL` (required)
- `HERZEN_RESPONSE_TIMEOUT_MS` (default `12000`)
- `HERZEN_RESPONSE_TEMPERATURE` (default `0.2`)
- `HERZEN_ALLOW_REMOTE_LLM` (optional override, default local-only)

Current error model:

- `CONFIG_INVALID`
- `RUNTIME_UNAVAILABLE`
- `GENERATION_FAILED`
- `OUTPUT_INVALID`

---

## Planned (not yet implemented)

Future packages may include:

- integrations (home automation, notes, calendar)

These are intentionally absent for now.

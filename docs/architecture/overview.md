# Herzen – Architecture Overview

Herzen is structured as a **local-first, modular assistant system**.

The goal is to keep each concern isolated:
audio, cognition, wake word detection, speech processing, and integrations
should evolve independently without forcing rewrites.

This document describes the _current_ architecture and intended direction.

---

## High-level architecture

At runtime, Herzen consists of a small number of long-running local processes.

Conceptually:

```
[ Microphone ]
↓
[ Wake Word ]
↓
[ Assistant Core ]
↓
[ STT → Logic → TTS ]
↓
[ Speakers / Files / Integrations ]
```

Only a subset of this pipeline is implemented so far.

---

## Current trigger boundary

Trigger detection is now isolated behind a `TriggerSource` interface in
`@herzen/core`.

Current trigger source modes:
- `stdin` (default): manual Enter key trigger
- `wakeword`: sidecar-backed trigger via `@herzen/wakeword`

Recording mode behavior:
- `adaptive` (VAD-based endpointing) is the default at startup
- `fixed` mode is available only when `HERZEN_ENABLE_FIXED_RECORDING=1`

The core orchestration loop consumes `TriggerSource` events and does not
directly wire terminal input semantics.
Trigger boundary failures are surfaced as typed trigger-domain errors
(`SOURCE_CLOSED`, `SOURCE_FAILED`) rather than ad-hoc
errno-like custom codes.

Wakeword implementation direction:
- local persistent daemon in a separate repo (`herzen-wake`)
- openWakeWord inference in daemon process (Python)
- Unix socket JSONL protocol between daemon and `@herzen/core`
- no service-account dependency for wakeword detection

Current status:
- wakeword sidecar contract is implemented in `@herzen/wakeword` + `@herzen/core`
- wakeword-triggered turns are available when the daemon is running
- daemon repository: <https://github.com/pavel-arkharov/herzen-wake>

Shared contract for both repos:
- [wakeword_sidecar_contract.md](./wakeword_sidecar_contract.md)

When triggered, the core currently:
- emits a short start cue once per triggered interaction
- when follow-up mode is enabled and a window closes, emits a distinct close cue
- records audio into `data/audio` using selected recording mode:
  - fixed: `HERZEN_RECORD_SECONDS` (default `3`)
  - adaptive: VAD-based endpointing via `@herzen/audio` + `@herzen/vad`
    - min duration `HERZEN_RECORD_MIN_SECONDS` (default `1`)
    - max duration `HERZEN_RECORD_MAX_SECONDS` (default `60`)
    - trailing silence window `HERZEN_RECORD_SILENCE_SECONDS` (default `0.7`)
    - no-speech timeout `HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS` (default `4`)
    - start threshold `HERZEN_VAD_START_THRESHOLD` (default `0.55`)
    - end threshold `HERZEN_VAD_END_THRESHOLD` (default `0.35`)
    - frame samples `HERZEN_VAD_FRAME_SAMPLES` (default `512`)
  - invalid adaptive config falls back to fixed recording for that turn
  - adaptive runtime failures also fall back to fixed recording for that turn
- runs local STT via `@herzen/stt` (`transcribeWav`)
- routes deterministic Home Assistant intents via `@herzen/integration-homeassistant` when enabled
  - supported now: `light.turn_on`, `light.turn_off`, `scene.turn_on`
  - if no HA intent matches, falls through to LLM generation
- generates local LLM replies via `@herzen/dialog` (Ollama provider)
- appends one structured STT event per trigger to `data/logs/stt.jsonl`
- optionally plays the recorded file when `HERZEN_PLAYBACK=1`
- speaks model-generated reply text when available, else a short fallback

Outside the live trigger loop, the repository also provides per-file transcription:
- `pnpm transcribe:file -- "<audio-file>"`
- default output path: `data/transcribes/`

Audio output path resolution is stable across launch directories:
- default data root resolves to repository `data/` from module location
- optional override via `HERZEN_DATA_DIR` (audio files go under `HERZEN_DATA_DIR/audio`)

---

## Monorepo philosophy

The repository is a **pnpm monorepo**.

- Each package represents one responsibility
- Packages communicate via function calls, CLI calls, or local IPC
- Heavy assets (models, audio, logs) are _never_ committed to git

---

## Active Rule: Journal Extraction Guardrail

For Phase 2 and HA MVP, conversation observability remains implemented in `@herzen/core`.

Core source ownership is now organized by bounded domains:

- `core/src/app/` runtime bootstrap and turn orchestration
- `core/src/conversation/` session journal, session watch, stream readers, context window, follow-up
- `core/src/observability/` logging, retention, performance journaling, envelope contracts
- `core/src/control/`, `core/src/context/`, `core/src/intent/`, `core/src/settings/`, `core/src/trigger/`, `core/src/recording/`, `core/src/replay/`
- `core/src/cli/` command entry adapters only

To keep future extraction cheap, the following guardrail remains active:

- keep `core/src/conversation/journal.ts`, `core/src/conversation/stream.ts`, and `core/src/observability/perf_journal.ts` dependency-light
- these modules should depend only on Node stdlib plus local helper modules in the same extraction boundary
- do not import trigger/runtime/audio/STT/TTS orchestration modules into these modules
- evolve schema/formatting in these modules first, and keep runtime wiring thin around them

This preserves a clean future move into a dedicated package without broad refactoring.

---

## Local-only data

All runtime data lives under the `data/` root:

```
data/
  audio/
  logs/
  transcribes/
  samples/
  models/
```

The `data/` directory is intentionally gitignored.

The system must remain usable even if the entire repository is copied to a new machine.

---

## Current packages

Eight packages are currently implemented: **audio**, **core**, **stt**, **tts**, **vad**, **wakeword**, **dialog**, and **integration-homeassistant**.

Notes:
- `@herzen/dialog` currently supports local Ollama-backed MVP replies
- `@herzen/integration-homeassistant` currently provides deterministic local HA control for allowlisted lights/scenes
- advanced response features (tools/memory/streaming) are intentionally deferred

More will be added later without breaking these.

See [packages/overview.md](../packages/overview.md) for detailed documentation of each.

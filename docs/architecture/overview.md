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
- `wakeword`: sidecar-backed trigger via `@herzen/wakeword` (currently in-progress for next stretch)

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
- wakeword client and protocol wiring exist
- dependable wakeword-triggered runtime flow is still an in-progress item for the next working stretch

Shared contract for both repos:
- [wakeword_sidecar_contract.md](./wakeword_sidecar_contract.md)

When triggered, the core currently:
- emits a short beep
- records audio into `data/audio` using `HERZEN_RECORD_MODE`:
  - `fixed` (default): `HERZEN_RECORD_SECONDS` (default `3`)
  - `adaptive` (experimental): silence-stop recording with:
    - max cap `HERZEN_RECORD_MAX_SECONDS` (default `10`)
    - min capture `HERZEN_RECORD_MIN_SECONDS` (default `1.0`)
    - trailing silence `HERZEN_RECORD_SILENCE_SECONDS` (default `0.8`)
    - silence threshold `HERZEN_RECORD_SILENCE_THRESHOLD` percent (default `1`)
    - no-speech timeout `HERZEN_RECORD_NO_SPEECH_TIMEOUT_SECONDS` (default `2.5`)
  - adaptive mode is currently known to be unreliable and does not yet behave as intended
  - adaptive mode is presently exposed via the interactive startup mode selector (`pnpm dev` in TTY)
  - invalid adaptive config falls back to fixed defaults for the current run
  - adaptive runtime failures fall back to one fixed recording attempt for the current turn
- runs local STT via `@herzen/stt` (`transcribeWav`)
- appends one structured STT event per trigger to `data/logs/stt.jsonl`
- optionally plays the recorded file when `HERZEN_PLAYBACK=1`
- speaks transcript-aware confirmation when transcription succeeds, else a short fallback

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

Five packages are currently implemented: **audio**, **core**, **stt**, **tts**, and **wakeword**.

More will be added later without breaking these.

See [packages/overview.md](../packages/overview.md) for detailed documentation of each.

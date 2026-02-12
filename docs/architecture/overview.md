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
- `wakeword`: placeholder adapter stub (`not implemented` for MVP)

The core orchestration loop consumes `TriggerSource` events and does not
directly wire terminal input semantics.
Trigger boundary failures are surfaced as typed trigger-domain errors
(`SOURCE_CLOSED`, `SOURCE_FAILED`, `NOT_IMPLEMENTED`) rather than ad-hoc
errno-like custom codes.

When triggered, the core currently:
- emits a short beep
- records ~5 seconds of audio into `data/audio`
- plays the recorded file back
- speaks a brief confirmation via TTS

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
  samples/
  models/
```

The `data/` directory is intentionally gitignored.

The system must remain usable even if the entire repository is copied to a new machine.

---

## Current packages

Three packages are currently implemented: **audio**, **core**, and **tts**.

More will be added later without breaking these.

See [packages/overview.md](../packages/overview.md) for detailed documentation of each.

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

## Monorepo philosophy

The repository is a **pnpm monorepo**.

- Each package represents one responsibility
- Packages communicate via function calls, CLI calls, or local IPC
- Heavy assets (models, audio, logs) are _never_ committed to git

---

## Local-only data

All runtime data lives under:

```
data/
audio/
logs/
samples/
models/
```

This directory is intentionally gitignored.

The system must remain usable even if the entire repository is copied to a new machine.

---

## Current packages

Only two packages are implemented at the moment.

More will be added later without breaking these.

See `packages/` for details.

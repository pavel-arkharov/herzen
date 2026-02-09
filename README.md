# Herzen

**Herzen** is a local-first, always-on personal voice assistant.

It is designed to:

- run fully on local hardware
- respect user ownership of data
- work offline by default
- integrate with the local file system and home devices
- grow incrementally without cloud dependency

The long-term vision is a calm, domestic intelligence:
a system that listens, responds, remembers, and writes into tools the user already trusts.

This repository is structured as a **pnpm monorepo**, with small, modular packages that can be developed and replaced independently.

---

## Current status

Early prototype stage.

At the moment, the system supports:

- local audio recording
- local audio playback
- a minimal “assistant core” loop that coordinates actions

Wake word detection, speech-to-text, text-to-speech, and integrations will be added incrementally.

---

## Monorepo structure (overview)

```
herzen/
packages/
core/ # assistant brain & orchestration
audio/ # audio input/output utilities
data/ # local-only runtime data (gitignored)
docs/ # architecture & design notes
```

Only `packages/core` and `packages/audio` are active right now.

---

## Principles

- **Local-first**: no cloud dependency by default
- **Modular**: components are small and replaceable
- **Human-paced**: optimized for reliability and calm, not novelty
- **Transparent**: data lives in plain files whenever possible

---

## License

TBD

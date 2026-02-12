# Text-to-Speech (TTS) in Herzen

This document describes the role of Text-to-Speech (TTS) in the Herzen project,
its goals, current implementation, and the intended evolution over time.

---

## Role of TTS in Herzen

In Herzen, TTS is the **final expression layer**.

After perception (wake word, speech-to-text) and cognition (intent resolution,
planning, tool use), TTS is how Herzen _responds_ to the user audibly.

TTS is deliberately treated as a **replaceable output module**, not as part of
the assistant’s core logic.

The core must never depend on _how_ speech is generated — only that speech
can be requested.

---

## Design goals

TTS in Herzen is designed with the following principles:

### 1. Local-first

- No cloud APIs
- No external services
- All speech synthesis runs on user-owned hardware

### 2. Modular and swappable

- The core calls a simple interface (`speak(text)`)
- The underlying engine can change without touching core logic

### 3. Calm and reliable

- Speech should be predictable
- Latency should be low
- Failures should degrade gracefully (e.g. silence instead of crashes)

### 4. Bilingual by design

- Herzen must be able to speak both **English** and **Russian**
- Language choice should be automatic or explicit per utterance

### 5. Personalization over time

- Early stages prioritize reliability
- Later stages prioritize voice quality and personal identity

---

## Current state (early prototype)

At the current stage, TTS is implemented using **macOS built-in speech synthesis**
via the `say` command.

Characteristics:

- 100% local
- Zero setup
- Uses system voices provided by macOS
- Supports multiple languages out of the box

Language selection is handled by:

- Explicit **leading** language tags in text (e.g. `[en]`, `[ru]`)
- Or a simple heuristic (presence of Cyrillic characters)

This implementation is intentionally simple and temporary.
Its purpose is to enable fast iteration and make the assistant “talk back” early.

Current dependency:
- macOS `say`

Current error behavior:
- Errors bubble to the caller; the core loop catches and continues

---

## Package structure

TTS lives in its own package:

```
packages/tts
```

Responsibilities:

- Selecting the appropriate language/voice
- Invoking the local TTS engine
- Exposing a minimal API to the core
- Providing a helper to list available system voices (`say -v ?`)

The core package never directly invokes system TTS tools.

---

## Planned evolution

TTS is expected to evolve in stages:

### Stage 1 — System voices (current)

- macOS `say`
- Focus on correctness and responsiveness
- Suitable for development and early daily use

### Stage 2 — Local neural TTS

- Replace system voices with a fully local neural TTS engine (e.g. Piper)
- Higher quality, more natural prosody
- Still fully offline and efficient

### Stage 3 — Personal voice synthesis

- Train or fine-tune a local TTS model on the user’s own voice
- Herzen speaks in a voice that resembles the user
- Treated as an optional personalization layer

Each stage replaces the _implementation_, not the interface.

---

## Non-goals

The following are explicitly out of scope for Herzen’s TTS:

- Cloud-based TTS APIs (e.g. ElevenLabs)
- Remote voice processing
- Data collection or analytics
- “Human impersonation” for deceptive purposes

---

## Summary

TTS in Herzen is not a feature — it is an **interface boundary**.

By keeping it local, modular, and simple at first, Herzen can:

- speak early
- evolve naturally
- remain trustworthy
- and avoid being locked into any single vendor or model

Voice quality can improve over time.
Architectural integrity must not be compromised.

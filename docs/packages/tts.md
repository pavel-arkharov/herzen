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

## Current state

At the current stage, TTS is implemented as a **provider boundary** with:

- `say` as the default provider
- optional local `piper` provider for EN/RU neural synthesis
- optional `xtts` sidecar provider for higher-quality local synthesis

Characteristics:

- 100% local
- Default path has zero setup (`say`)
- Optional sidecar path stays local and loopback-only by default
- Supports multiple languages (English/Russian) out of the box
- Provider failure can fall back to configured local fallback provider (`say` by default)

Language selection is handled by:

- Explicit **leading** language tags in text (e.g. `[en]`, `[ru]`)
- Or a simple heuristic (presence of Cyrillic characters)

Current dependencies:
- macOS `say`
- local `piper` CLI (when `HERZEN_TTS_PROVIDER=piper`)
- local audio playback tool (`play` from SoX, with `afplay` fallback)
- optional local XTTS sidecar endpoint (`POST /synthesize`)

Current environment surface:

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

Current error behavior:
- Provider failures (`piper` or `xtts`) can fall back once to the configured fallback provider
- unrecoverable provider errors bubble to the caller; the core loop catches and continues

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

### Stage 1 — System voices (current baseline)

- macOS `say`
- Focus on correctness and responsiveness
- Suitable for development and early daily use

### Stage 2 — Local neural TTS (in progress)

- Optional Piper provider for lightweight local neural synthesis
- Optional XTTS sidecar provider for higher quality and voice-profile path
- Still fully offline and local-first

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

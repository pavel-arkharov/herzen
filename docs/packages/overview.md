# Packages

This document lists the current packages in the Herzen monorepo.

**core**, **audio**, **stt**, and **tts** are currently implemented.
Other packages (wake word, integrations) will be added later.

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

Current system dependency:
- `rec` and `play` from SoX

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
- includes a `wakeword` trigger adapter stub marked as `not implemented` (MVP)
- uses typed trigger-domain errors for control flow (`SOURCE_CLOSED`, `SOURCE_FAILED`, `NOT_IMPLEMENTED`)
- keeps a runtime-lifecycle `stdin` error listener in the trigger source, including during pipeline handling
- resolves default data output to repo-local `data/audio` independently of launch cwd
- supports `HERZEN_DATA_DIR` override (writes to `HERZEN_DATA_DIR/audio`)
- writes runtime structured logs to `data/logs/runtime.jsonl`
- writes STT turn logs to `data/logs/stt.jsonl`
- supports log level control through `HERZEN_LOG_LEVEL` (`info`, `warn`, `error`; default `info`)
- gates transcript persistence in logs with `HERZEN_LOG_TRANSCRIPT` (default disabled)
- sanitizes JSONL stream names and degrades logging sink failures to console warnings
- emits a short beep
- records audio to `data/audio` (default `3` seconds, configurable via `HERZEN_RECORD_SECONDS`)
- runs local STT transcription and logs per-turn telemetry (latency, duration, language mode, detected language, optional error code)
- plays the recording only when `HERZEN_PLAYBACK=1`
- speaks transcript-aware confirmation or a fallback message

---

## @herzen/stt

**Purpose**  
Local speech-to-text utilities.

This package is responsible for:

- converting local WAV files to text via whisper.cpp CLI
- validating STT runtime/model configuration
- normalizing transcription output and error typing for callers

Current backend:
- `whisper.cpp` CLI (`whisper-cli` fallback on `PATH`)

Current environment surface:
- `HERZEN_WHISPER_MODEL` (required model file path)
- `HERZEN_WHISPER_BIN` (optional binary path override)
- `HERZEN_STT_LANGUAGE` (`auto`, `en`, `ru`; optional default mode)
- `HERZEN_STT_THREADS` (optional positive integer)

Current error model:
- `RUNTIME_MISSING`
- `MODEL_MISSING`
- `TRANSCRIBE_FAILED`
- `OUTPUT_PARSE_FAILED`

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

## Planned (not yet implemented)

Future packages may include:

- wakeword (wake word detection)
- integrations (home automation, notes, calendar)

These are intentionally absent for now.

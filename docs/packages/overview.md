# Packages

This document lists the current packages in the Herzen monorepo.

**core**, **audio**, and **tts** are currently implemented.
Other packages (wake word, speech-to-text, integrations) will be added later.

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
- will eventually host:
  - wake word routing
  - speech-to-text
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
- emits a short beep
- records ~5 seconds of audio to `data/audio`
- plays the recording back
- speaks a short confirmation via TTS

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
- stt (speech-to-text)
- integrations (home automation, notes, calendar)

These are intentionally absent for now.

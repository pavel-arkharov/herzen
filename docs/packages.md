# Packages

This document lists the current packages in the Herzen monorepo.

Only **core** and **audio** exist at this stage.
Everything else will be introduced later.

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

---

## Planned (not yet implemented)

Future packages may include:

- wakeword
- stt
- tts
- integrations (home automation, notes, calendar)

These are intentionally absent for now.

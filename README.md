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

## Name

The name has a four-part origin:

- **Alexander Herzen**, a Russian thinker who is personally meaningful
- the film **Her**, which seeded the project’s vision
- **Zen**, as a shorthand for calm presence
- the German sense of “**herzen**” as the feeling of a hug

---

## Current status

Early prototype stage.

At the moment, the system supports:

- local audio recording
- local audio playback
- a minimal “assistant core” loop that coordinates actions
- initial local speech-to-text via `@herzen/stt` (whisper.cpp CLI wrapper)
- per-file audio-to-text transcription via `pnpm transcribe:file` (txt or markdown output)
- a trigger source boundary with `stdin` mode by default (`Enter` trigger)
- selectable trigger mode via `HERZEN_TRIGGER_MODE` (`stdin`, `wakeword`) plus interactive startup prompt
- wakeword sidecar integration via `@herzen/wakeword` (Unix socket JSONL client for `herzen-wake`), with trigger path still in-progress for the next working stretch
- fixed-length recording via `HERZEN_RECORD_SECONDS` (default `3`)
- stable repo-local data pathing by default with optional `HERZEN_DATA_DIR` override
- local text-to-speech via macOS `say`

Wakeword daemon/client contracts are in place, but reliable wakeword-triggered turns are still treated as next-stretch implementation work.

---

## System dependencies (current prototype)

- SoX (`rec` and `play`) for audio capture and playback
- macOS `say` for text-to-speech
- whisper.cpp CLI (`whisper-cli` on PATH or `HERZEN_WHISPER_BIN`) for STT transcription
- local whisper model file path via `HERZEN_WHISPER_MODEL` for STT transcription
- optional for `.m4a` file transcription: `ffmpeg` (preferred) or `afconvert` (macOS fallback)

---

## Monorepo structure (overview)

```
herzen/
packages/
  core/ # assistant brain & orchestration
  audio/ # audio input/output utilities
  stt/ # speech-to-text utilities
  tts/ # text-to-speech utilities
  wakeword/ # wakeword sidecar client utilities
data/ # local-only runtime data (gitignored)
  audio/
  logs/
  transcribes/
docs/ # architecture, packages, and design notes
```

Active packages: `packages/core`, `packages/audio`, `packages/stt`, `packages/tts`, `packages/wakeword`.

---

## File Transcription

Run audio-to-text transcription for a single file:

```bash
# from repository root
pnpm transcribe:file -- "data/audio/sample.wav"

# force language + markdown output
pnpm transcribe:file -- "data/audio/sample.wav" --lang en --format md

# explicit input flag and custom output path
pnpm transcribe:file -- --input "meeting.m4a" --out "data/transcribes/meeting.txt" --format txt
```

CLI options:

- input: positional `<file>` or `--input <path>`
- language: `--lang auto|en|ru` (default `auto`)
- format: `--format txt|md` (default `md`)
- output file: `--out <path>`
- output basename: `--name <base-name>`

Default output path when `--out` is omitted:

- `data/transcribes/<sanitized-input-name>-<timestamp>.<format>`

Supported input formats:

- direct: `.wav`, `.mp3`, `.ogg`, `.flac`
- auto-converted: `.m4a` (via `ffmpeg` or `afconvert`)

---

## Testing

- Run all tests: `pnpm test`
- Watch mode: `pnpm test:watch`
- Coverage report: `pnpm test:coverage`
- Run a single package test suite:
  - `pnpm test:core`
  - `pnpm test:audio`
  - `pnpm test:stt`
  - `pnpm test:tts`
  - `pnpm test:wakeword`

Current baseline is focused unit coverage for trigger handling, STT/core turn orchestration, file-transcription CLI/document generation, and package command-wrapper behavior.

---

## Principles

- **Local-first**: no cloud dependency by default
- **Modular**: components are small and replaceable
- **Human-paced**: optimized for reliability and calm, not novelty
- **Transparent**: data lives in plain files whenever possible

---

## License

TBD

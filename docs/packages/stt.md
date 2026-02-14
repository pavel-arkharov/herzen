# Speech-to-Text (STT) in Herzen

This document describes the current `@herzen/stt` package implementation and how it behaves in the prototype.

---

## Role of STT in Herzen

`@herzen/stt` provides local transcription from WAV audio files.

The package is intentionally narrow:

- input: local WAV file path
- output: normalized transcription result
- failure mode: typed `SttError` codes

Core orchestration remains in `@herzen/core`.

---

## Current backend

Current STT backend is `whisper.cpp` CLI.

Resolution order for CLI binary:

1. `HERZEN_WHISPER_BIN` (if set)
2. `whisper-cli` on `PATH`

Model path:

- `HERZEN_WHISPER_MODEL` is required and must point to an existing local model file.

Language mode:

- default `auto`
- optional explicit mode from `HERZEN_STT_LANGUAGE` (`auto`, `en`, `ru`)

Optional performance tuning:

- `HERZEN_STT_THREADS` (positive integer)

---

## Public API

`@herzen/stt` exports:

- `transcribeWav(filePath: string, options?: SttOptions): Promise<SttResult>`
- `SttError`
- `SttErrorCode`
- `SttOptions`
- `SttResult`

`SttResult` fields:

- `text`
- `language`
- `backend` (`"whisper.cpp"`)
- `durationMs`

---

## Error model

Current typed error codes:

- `RUNTIME_MISSING`: whisper CLI binary cannot be resolved
- `MODEL_MISSING`: model path missing or not found
- `TRANSCRIBE_FAILED`: process execution or configuration failure
- `OUTPUT_PARSE_FAILED`: transcription output could not be parsed

---

## Integration in Core

Current `@herzen/core` trigger flow:

1. Record WAV audio.
2. Call `transcribeWav`.
3. Log STT event to `data/logs/stt.jsonl`.
4. Speak transcript-aware confirmation when non-empty, otherwise fallback speech.

If STT fails, core logs the error and continues the loop.

# Speech-to-Text (STT) in Herzen

This document describes the current `@herzen/stt` package implementation and how it behaves in the prototype.

---

## Role of STT in Herzen

`@herzen/stt` provides local transcription from local audio files.

The package is intentionally narrow:

- input: local audio file path
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

Dependencies for file transcription:

- required: whisper.cpp CLI + local model file
- optional for `.m4a` input: `ffmpeg` (preferred) or `afconvert` (fallback)

---

## Public API

`@herzen/stt` exports:

- `transcribeWav(filePath: string, options?: SttOptions): Promise<SttResult>`
- `transcribeFileToDocument(options): Promise<TranscribeDocumentResult>`
- `SttError`
- `SttErrorCode`
- `SttOptions`
- `SttResult`
- `TranscribeFileToDocumentOptions`
- `TranscribeDocumentResult`

`SttResult` fields:

- `text`
- `language`
- `backend` (`"whisper.cpp"`)
- `durationMs`

`TranscribeDocumentResult` fields:

- `outputPath`
- `text`
- `language`
- `durationMs`
- `format`

---

## Package And Output Structure

Package source layout:

```
packages/stt/
  src/transcribe.ts  # whisper runtime wrapper + format conversion
  src/document.ts    # txt/md output renderer and file writer
  src/cli.ts         # herzen-stt CLI argument parser and runner
  src/index.ts       # public exports
```

Default runtime output folder for file transcription:

```
data/
  transcribes/
```

---

## CLI usage

`@herzen/stt` now ships a CLI entrypoint for file-to-document transcription.

From repository root:

```bash
pnpm transcribe:file -- "data/audio/sample.wav" --lang en --format md
```

Arguments:

- required: `<file>` positional or `--input <path>`
- optional: `--lang auto|en|ru` (default `auto`)
- optional: `--format txt|md` (default `md`)
- optional: `--out <output-file-path>`
- optional: `--name <output-file-basename>`

Default output destination when `--out` is omitted:

- `/Users/parkharo/Programming/herzen/data/transcribes/<sanitized-input-basename>-<timestamp>.<format>`

Output content:

- `txt`: transcript text only
- `md`: transcript plus metadata (`source path`, requested language mode, detected language, generated timestamp)

Accepted input formats:

- direct: `.wav`, `.mp3`, `.ogg`, `.flac`
- `.m4a`: auto-converted to wav before whisper invocation
  - preferred converter: `ffmpeg`
  - fallback converter: `afconvert` (macOS, best-effort only)

Package-local invocation alternative:

```bash
pnpm --filter @herzen/stt transcribe:file -- --input "data/audio/sample.wav"
```

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

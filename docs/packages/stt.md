# Speech-to-Text (STT) in Herzen

This document describes the current `@herzen/stt` package implementation and how it behaves in the prototype.

---

## Role of STT in Herzen

`@herzen/stt` provides local transcription from local audio files and
duration-bounded microphone capture sessions.

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
- `HERZEN_WHISPER_NO_GPU` (`1`/`true`/`yes`/`on`) to force CPU mode when GPU startup is unstable

Dependencies for file transcription:

- required: whisper.cpp CLI + local model file
- optional for compressed audio input (`.m4a`, `.mp3`, `.ogg`, `.flac`): `ffmpeg` (preferred) or `afconvert` (fallback)

---

## Public API

`@herzen/stt` exports:

- `transcribeWav(filePath: string, options?: SttOptions): Promise<SttResult>`
- `transcribeFileToDocument(options): Promise<TranscribeDocumentResult>`
- `transcribeMicrophoneToDocument(options): Promise<TranscribeMicrophoneToDocumentResult>`
- `SttError`
- `SttErrorCode`
- `SttOptions`
- `SttResult`
- `TranscribeFileToDocumentOptions`
- `TranscribeDocumentResult`
- `TranscribeMicrophoneToDocumentOptions`
- `TranscribeMicrophoneToDocumentResult`

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
  src/listen.ts      # timed microphone capture + transcript writer
  src/cli.ts         # herzen-stt CLI argument parser and runner
  src/listen_cli.ts  # herzen-stt-listen CLI for unattended mic sessions
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

- `data/transcribes/<sanitized-input-basename>-<timestamp>.<format>`

Output content:

- `txt`: transcript text only
- `md`: transcript plus metadata (`source path`, requested language mode, detected language, generated timestamp)

Accepted input formats:

- direct: `.wav`
- `.mp3`, `.ogg`, `.flac`, `.m4a`: auto-converted to wav before whisper invocation
  - preferred converter: `ffmpeg`
  - fallback converter: `afconvert` (macOS, best-effort only)

Package-local invocation alternative:

```bash
pnpm --filter @herzen/stt transcribe:file -- --input "data/audio/sample.wav"
```

---

## Microphone session CLI

`@herzen/stt` also ships a microphone transcription command for unattended
capture.

From repository root:

```bash
herzen transcribe

pnpm transcribe:mic -- --duration-minutes 53 --chunk-seconds 30 --lang en --out data/transcribes/secure-player-live.txt --name secure-player-session

pnpm transcribe:mic -- --until-stopped --chunk-seconds 20 --lang auto --out data/transcribes/mixed-session-live.txt --name mixed-session
```

`herzen transcribe` is the shorter interactive entrypoint. When run in a TTY it
prompts for:

- duration, such as `53m`, `120s`, `02:00`, or `until-stopped`
  Leaving duration empty defaults to `until-stopped`.
- chunk seconds, default `60`
- output filename, defaulting to a timestamped `.txt` file in `data/transcribes/`

`herzen transcribe` defaults language mode to `auto`, which is a better fit for
mixed English/Russian sessions unless you override it with `--lang`.

You can also skip prompts and pass flags directly:

```bash
herzen transcribe --duration 53m --chunk 300 --output secure-player-live.txt --lang auto
```

Arguments:

- required: one of `--duration-minutes <minutes>`, `--duration-seconds <seconds>`, or `--until-stopped`
- optional: `--chunk-seconds <seconds>` to enable rolling live transcription while recording
- optional: `--lang auto|en|ru` (default `en`)
- optional: `--format txt|md` (default `txt`)
- optional: `--out <output-file-path>`
- optional: `--name <output-file-basename>`
- optional: `--audio-out <recorded-wav-path>`
- optional: `--audio-dir <recorded-wav-directory>`

Default outputs when explicit paths are omitted:

- transcript: `data/transcribes/<name>-<timestamp>.<format>`
- recorded wav: `data/audio/<name>-<timestamp>.wav`

Operational behavior:

- records continuously from the default microphone for the requested duration, or until you stop it with `Ctrl+C`
- when `--chunk-seconds` is set, records rolling audio chunks and rewrites the transcript file as each closed chunk lands
- rolling chunk transcription includes a small amount of audio from the previous chunk so border words are less likely to be split awkwardly
- `--until-stopped` uses rolling chunks by default so the transcript file can stay open in an editor while capture continues
- without `--chunk-seconds`, fixed-duration capture still records first and transcribes after recording finishes
- does not invoke the assistant reply or TTS loop
- is a better fit than `@herzen/core` when you need an unattended transcript of external audio playback

---

## Error model

Current typed error codes:

- `RUNTIME_MISSING`: whisper CLI binary cannot be resolved
- `MODEL_MISSING`: model path missing or not found
- `TRANSCRIBE_FAILED`: process execution or configuration failure
- `OUTPUT_PARSE_FAILED`: transcription output could not be parsed

If `whisper.cpp` fails during GPU startup, `transcribeWav` now retries on CPU
automatically. You can also force CPU mode up front with
`HERZEN_WHISPER_NO_GPU=1`.

---

## Integration in Core

Current `@herzen/core` trigger flow:

1. Record WAV audio (fixed or adaptive endpointing mode).
2. Call `transcribeWav`.
3. Log STT event to `data/logs/stt.jsonl`.
4. If transcript is non-empty, pass transcript + language metadata to `@herzen/dialog` for local LLM reply generation.
5. Speak model reply on success; otherwise speak a short language-aware fallback.

If STT fails, core logs the error, writes telemetry/journal entries, and continues the loop.

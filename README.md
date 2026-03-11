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
- selectable trigger mode via `HERZEN_TRIGGER_MODE` (`stdin`, `wakeword`)
- wakeword sidecar integration via `@herzen/wakeword` (Unix socket JSONL client for [`herzen-wake`](https://github.com/pavel-arkharov/herzen-wake))
- non-interactive default startup for `pnpm dev` with explicit setup flow (`pnpm --filter @herzen/core setup:interactive`)
- runtime interaction profiles in core (`voice`, `text`, `hybrid`) controlled via env/runtime overrides/live control commands
- fixed recording via `HERZEN_RECORD_SECONDS` (default `3`)
- adaptive recording via `@herzen/vad`-backed endpointing (speech start/stop thresholds, silence window, max cap, no-speech timeout)
- stable repo-local data pathing by default with optional `HERZEN_DATA_DIR` override
- local text-to-speech via `@herzen/tts` providers (`say` default, optional local `xtts` sidecar)
- local LLM-backed reply generation via `@herzen/dialog` (`ollama` or `llama-server` provider, text-in/text-out)
- in-session short-term context window for LLM requests (bounded by `HERZEN_CONTEXT_ENABLED`, `HERZEN_CONTEXT_MAX_TURNS`, `HERZEN_CONTEXT_MAX_CHARS`)
- kernel prompt override for LLM behavior via `HERZEN_KERNEL_PROMPT` (legacy compatibility: `HERZEN_CONTEXT_KERNEL_PROMPT`)
- optional persona prompt layering for LLM replies (`HERZEN_PERSONA_ENABLED`, `HERZEN_PERSONA_PROMPT`)
- optional conversational follow-up mode after each reply (default off) with bounded window/turns (`HERZEN_FOLLOWUP_ENABLED`, `HERZEN_FOLLOWUP_WINDOW_SECONDS`, `HERZEN_FOLLOWUP_MAX_TURNS`, `HERZEN_FOLLOWUP_STOP_PHRASES`)
  - `HERZEN_FOLLOWUP_WINDOW_SECONDS` is the per-turn silence wait budget in follow-up mode
- deterministic Home Assistant light on/off handling via `@herzen/integration-homeassistant` with allowlisted entities/aliases
- operator TUI (`pnpm tui`) with `NORMAL`/`INSERT` modes, chat composer, actions/perf/settings panels, profile/voice controls, ingress lifecycle frame, and control ingress (`data/control/ingress.jsonl`)
- core heartbeat/status contract at `data/control/core_status.json` used by TUI for explicit online/offline state
- startup runtime settings override merge from `data/control/runtime_settings.json`
- configurable TUI user role label via `USER_NAME` (settings key `tui.user_name`, default `USER`); assistant label currently shown as `Herzen`

Wakeword mode now runs through the external `herzen-wake` daemon and can trigger full turns in `@herzen/core`.

---

## Beginner setup

For a non-technical, step-by-step local setup guide, use:

- `runbook.md`

---

## System dependencies (current prototype)

- SoX (`rec` and `play`) for audio capture and playback
- macOS `say` for default text-to-speech
- optional local Piper models for neural text-to-speech:
  - `HERZEN_TTS_PROVIDER=piper`
  - `HERZEN_TTS_PIPER_MODEL_EN` (absolute path to EN `.onnx`)
  - `HERZEN_TTS_PIPER_MODEL_RU` (absolute path to RU `.onnx`)
  - `HERZEN_TTS_PIPER_CONFIG_EN` (optional EN `.onnx.json`)
  - `HERZEN_TTS_PIPER_CONFIG_RU` (optional RU `.onnx.json`)
  - optional synthesis knobs:
    - `HERZEN_TTS_RATE_SCALE`
    - `HERZEN_TTS_NOISE_SCALE`
    - `HERZEN_TTS_NOISE_W`
  - expected model placement: `data/models/tts/piper/<lang>/...`
- optional local XTTS sidecar endpoint for higher-quality text-to-speech:
  - `HERZEN_TTS_PROVIDER=xtts`
  - `HERZEN_TTS_XTTS_ENDPOINT` (default `http://127.0.0.1:8020`)
  - `HERZEN_TTS_XTTS_TIMEOUT_MS` (default `12000`)
  - `HERZEN_TTS_XTTS_VOICE_PROFILE` (default `default`)
  - `HERZEN_TTS_FALLBACK_PROVIDER` (default `say`)
  - `HERZEN_ALLOW_REMOTE_TTS` (default disabled; loopback-only endpoint guard)
- optional expressive controls across providers:
  - `HERZEN_TTS_STYLE` (`neutral|calm|empathetic|excited|shy|scared|playful`, default `neutral`)
  - `HERZEN_TTS_SENTENCE_PAUSE_MS` (default `180`)
  - `HERZEN_TTS_SAY_RATE_WPM` (optional base words-per-minute for `say`)
- whisper.cpp CLI (`whisper-cli` on PATH or `HERZEN_WHISPER_BIN`) for STT transcription
- local whisper model file path via `HERZEN_WHISPER_MODEL` for STT transcription
- Silero VAD model file for adaptive recording:
  - default path: `data/models/silero_vad.onnx`
  - override: `HERZEN_VAD_MODEL`
- optional for `.m4a` file transcription: `ffmpeg` (preferred) or `afconvert` (macOS fallback)

Wakeword mode dependency:

- local `herzen-wake` daemon running in a separate terminal:
  - repo: [`pavel-arkharov/herzen-wake`](https://github.com/pavel-arkharov/herzen-wake)
  - transport: Unix socket (`HERZEN_WAKEWORD_SOCKET`, default under `data/run/wakeword.sock`)

LLM response dependency:

- local Ollama runtime (`ollama serve`) or `llama-server` (llama.cpp) for `@herzen/dialog`
- runtime selection via `HERZEN_RESPONSE_PROVIDER` (`ollama` default; optional `llama-server`)
- model selection via:
  - `HERZEN_OLLAMA_MODEL` (required for `ollama`)
  - `HERZEN_LLAMA_SERVER_MODEL` (optional for `llama-server`, default `llama-server`)
- optional endpoint override via:
  - `HERZEN_OLLAMA_BASE_URL` (loopback-only by default)
  - `HERZEN_LLAMA_SERVER_BASE_URL` (loopback-only by default)
- optional kernel/persona controls:
  - `HERZEN_KERNEL_PROMPT` (or legacy `HERZEN_CONTEXT_KERNEL_PROMPT`)
  - `HERZEN_PERSONA_ENABLED=1`
  - `HERZEN_PERSONA_PROMPT`

Home Assistant integration dependency:

- reachable Home Assistant instance on LAN
- `HERZEN_HA_ENABLED=1`
- configure one of:
  - `HERZEN_HA_SECRETS_DIR` with files:
    - `base_url`
    - `token` (owner-only, `chmod 600`)
  - or explicit file paths:
    - `HERZEN_HA_BASE_URL_FILE`
    - `HERZEN_HA_TOKEN_FILE` (owner-only, `chmod 600`)
  - or inline values (least preferred):
    - `HERZEN_HA_BASE_URL`
    - `HERZEN_HA_TOKEN`
- light scope controls:
  - `HERZEN_HA_ALLOWED_LIGHTS` (comma-separated `light.entity_id` values)
  - `HERZEN_HA_LIGHT_ALIASES` (comma-separated `alias=light.entity_id|light.other_id` mappings)
  - `HERZEN_HA_SCENE_ALIASES` (comma-separated `alias=scene.entity_id` mappings)
  - `HERZEN_HA_DEFAULT_LIGHT` (fallback entity when a single target is implied)

Home Assistant setup preference:

- use file-based secrets under `data/secrets/home_assistant`:
  - `base_url`
  - `token` (owner-only permission, `chmod 600`)
- set `HERZEN_HA_SECRETS_DIR` to that folder
- keep `HERZEN_HA_ENABLED=1`

---

## Monorepo structure (overview)

```
herzen/
packages/
  core/ # assistant brain & orchestration
  audio/ # audio input/output utilities
  stt/ # speech-to-text utilities
  tts/ # text-to-speech utilities
  vad/ # voice activity detection (Silero VAD wrapper)
  wakeword/ # wakeword sidecar client utilities
  dialog/ # local LLM dialog generation boundary
  integration-homeassistant/ # deterministic local Home Assistant light control
  tui/ # operator terminal UI
data/ # local-only runtime data (gitignored)
  audio/
  logs/
  transcribes/
docs/ # architecture, packages, and design notes
```

Active packages: `packages/core`, `packages/audio`, `packages/stt`, `packages/tts`, `packages/vad`, `packages/wakeword`, `packages/dialog`, `packages/integration-homeassistant`, `packages/tui`.

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

## Home Assistant Usage (Deterministic)

With HA enabled, core checks deterministic HA intent mapping before calling the LLM:

- scene alias match -> `scene.turn_on`
- light on/off intent + alias/entity match -> `light.turn_on` / `light.turn_off`
- no HA match -> normal `@herzen/dialog` LLM response path

Example utterances:

- `Herzen, living room lights on`
- `Herzen, спальня свет выключи`
- `Herzen, bedroom reading`
- `Herzen, corridor nightlight`

Current limitation:

- one utterance triggers one HA action (command chaining is not implemented yet)

---

## Turn Benchmark Logs

Herzen now writes per-turn latency benchmark entries to:

- `data/logs/turn_benchmark.jsonl`

Each JSONL line includes:

- timestamp checkpoints per turn (`trigger_received`, `recording_started`, `recording_finished`, `stt_started`, `stt_finished`, `ha_intent_started`, `ha_intent_finished`, `llm_started`, `llm_first_token`, `llm_finished`, `tts_started`, `tts_first_audio_sample`, `tts_finished`)
- computed latencies (`stt_ms`, `ha_intent_ms`, `llm_ms`, `tts_ms`, `end_to_end_ms`, `speak_tail_ms`)
- split dimensions (`triggerMode`, `actionPath`, `language`)

Related streams still available:

- `data/logs/perf.jsonl` (phase + process samples)
- `data/logs/runtime.jsonl`
- `data/logs/stt.jsonl`

Perf logging env vars:

- `HERZEN_LOG_PERF` (default enabled; set `0` to disable perf stream writes)
- `HERZEN_PERF_SAMPLE_MS` (process sample interval in ms, default `1000`)

Example quick checks:

```bash
# count collected benchmark turns
wc -l data/logs/turn_benchmark.jsonl

# inspect latest 5 turns
tail -n 5 data/logs/turn_benchmark.jsonl

# live conversation + benchmark watch (canonical)
pnpm conversation:watch

# backward-compatible alias (deprecated)
pnpm dialog:tail

# start operator TUI (chat/actions/perf/settings)
pnpm tui
```

## Run Modes

```bash
# configure runtime defaults once (interactive)
pnpm --filter @herzen/core setup:interactive

# daily core runtime (non-interactive)
pnpm dev

# optional legacy interactive startup prompts
HERZEN_STARTUP_INTERACTIVE=1 pnpm dev
```

`setup:interactive` is a one-time setup helper that writes runtime defaults into
`data/control/runtime_settings.json` (recording mode, trigger mode, runtime profile,
and adaptive max duration when adaptive mode is selected).

## TUI Quick Controls

- Start core: `pnpm dev`
- Start TUI (separate terminal): `pnpm tui`
- Insert mode: `Enter` send, `Esc` normal
- Normal mode: `i` insert (auto-jumps to `Chat`), `1`/`2`/`3`/`s` tabs
- Runtime controls: `v`/`t`/`h` profile, `r` voice-once, `w` wakeword toggle

`conversation:watch` now prints compact per-turn benchmark latency lines by default.
Use `pnpm conversation:watch -- --no-benchmark` to hide benchmark lines.
`pnpm dialog:tail` remains available as a compatibility alias with a deprecation warning.

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
  - `pnpm test:dialog`
  - `pnpm --filter @herzen/vad test`

Current baseline is focused unit coverage for trigger handling, STT/core turn orchestration, adaptive VAD recording behavior, file-transcription CLI/document generation, and package command-wrapper behavior.

## Development Notes

- Core dev/start scripts run `scripts/ensure_workspace_builds.mjs` to auto-build stale `@herzen/dialog` and `@herzen/tts` artifacts before launch.
- During an active dev session, changes under `packages/dialog/src` or `packages/tts/src` still require rebuild + process restart:
  - `pnpm --filter @herzen/dialog build`
  - `pnpm --filter @herzen/tts build`

---

## Principles

- **Local-first**: no cloud dependency by default
- **Modular**: components are small and replaceable
- **Human-paced**: optimized for reliability and calm, not novelty
- **Transparent**: data lives in plain files whenever possible

---

## License

TBD

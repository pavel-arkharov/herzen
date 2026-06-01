# Herzen

Herzen is a local-first personal voice assistant prototype built as a TypeScript
monorepo. It explores how an always-on assistant can run on user-owned hardware,
coordinate local AI components, and keep runtime data in inspectable files
instead of cloud services.

The project is intentionally engineering-first: small package boundaries,
deterministic local integrations, explicit runtime state, and testable adapters
around speech, language, wakeword, and home automation components.

## Why This Exists

Most voice assistants trade convenience for cloud dependency and opaque state.
Herzen takes the opposite direction:

- local execution by default
- user-owned audio, logs, transcripts, and conversation journals
- replaceable adapters for STT, TTS, LLM, wakeword, and device integrations
- plain-file observability for debugging and replay
- explicit invocation and control boundaries

The long-term goal is a calm domestic assistant that can listen, respond,
remember, and act inside tools the user already controls.

## Current Status

Herzen is an early prototype, but the main orchestration path is implemented.

Current capabilities include:

- voice-triggered or text-triggered interaction through `@herzen/core`
- local speech-to-text through `whisper.cpp`
- local LLM replies through Ollama or `llama-server`
- local text-to-speech through macOS `say`, Piper, or an XTTS sidecar
- adaptive voice endpointing through Silero VAD
- wakeword daemon integration through a Unix socket JSONL protocol
- deterministic Home Assistant light and scene control
- operator TUI with chat ingress, actions, perf, and runtime settings panels
- structured logs, conversation journals, replay fixtures, and per-turn timings
- file transcription CLI for local audio-to-text workflows

This is not a hosted product, SaaS backend, or general chatbot wrapper. It is a
local AI systems project focused on orchestration, privacy, runtime control, and
debuggable integration boundaries.

## Architecture

The repository is organized as a `pnpm` workspace with one package per major
runtime boundary:

```text
packages/
  audio/                     audio capture, playback, and VAD endpointing glue
  core/                      assistant runtime, turn orchestration, control plane
  dialog/                    local LLM provider boundary
  integration-homeassistant/ deterministic Home Assistant intent/action handling
  stt/                       whisper.cpp transcription wrapper and CLI
  tts/                       local speech synthesis provider boundary
  tui/                       terminal operator UI and text ingress
  vad/                       Silero VAD ONNX wrapper
  wakeword/                  wakeword sidecar client
```

At runtime, the core coordinates local services rather than embedding heavy model
execution directly:

```text
trigger -> recording -> STT -> deterministic intent routing -> LLM -> TTS
                 |                 |                         |
                 v                 v                         v
              data/audio      Home Assistant             data/logs
```

The companion wakeword daemon lives in
[`herzen-wake`](https://github.com/pavel-arkharov/herzen-wake).

## Technology

- TypeScript, Node.js, pnpm workspaces
- Vitest, TypeScript project references, ESLint
- `whisper.cpp` for local STT
- Ollama or `llama-server` for local LLM inference
- Silero VAD through `onnxruntime-node`
- SoX, Piper, XTTS sidecar, and macOS `say` for audio/TTS paths
- Home Assistant REST API for local device control
- JSONL and Markdown for runtime observability and conversation journals

## Quick Start

The project is currently developed and tested primarily on macOS.

Install workspace dependencies:

```bash
pnpm install
```

Configure the required local model paths:

```bash
cp .envrc.example .envrc
```

At minimum, set:

```bash
export HERZEN_WHISPER_BIN="/opt/homebrew/bin/whisper-cli"
export HERZEN_WHISPER_MODEL="$PWD/data/models/ggml-base.bin"
export HERZEN_WHISPER_NO_GPU="1" # recommended on machines where whisper Metal init is unstable
export HERZEN_OLLAMA_MODEL="qwen2.5:3b"
```

Run one-time runtime setup:

```bash
pnpm --filter @herzen/core setup:interactive
```

Start the assistant core:

```bash
pnpm dev
```

Start the operator TUI in another terminal:

```bash
pnpm tui
```

For a full macOS setup path, including system dependencies and model download
notes, see [runbook.md](runbook.md).

## Common Commands

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
herzen transcribe
pnpm transcribe:file -- "data/audio/sample.wav"
pnpm transcribe:mic -- --duration-minutes 53 --chunk-seconds 30 --lang en --out data/transcribes/secure-player-live.txt --name secure-player-session
pnpm transcribe:mic -- --until-stopped --chunk-seconds 20 --lang auto --out data/transcribes/mixed-session-live.txt --name mixed-session
pnpm conversation:watch
pnpm tui
```

Rolling microphone transcripts are rewritten in place as chunks land, with a
small chunk-context overlap to reduce awkward border splits.

Inside the repo, `herzen transcribe` is available through `direnv` and prompts
for duration, chunk size, and output filename when you omit flags. It defaults
to `auto` language mode for mixed English/Russian capture.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture/overview.md)
- [Design principles](docs/design_principles.md)
- [Package overview](docs/packages/overview.md)
- [Testing approach](docs/tests/testing_approach.md)
- [Beginner runbook](runbook.md)

## Project Principles

- Local-first: essential functionality should work without a cloud dependency.
- Modular: speech, dialog, triggers, integrations, and UI are replaceable.
- Observable: runtime state is written to plain files wherever practical.
- Controlled: local device actions are deterministic and allowlisted.
- Human-paced: the assistant is optimized for reliability and legibility over novelty.

## License

No open-source license has been selected yet.

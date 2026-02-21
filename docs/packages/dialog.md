# Dialog Package (`@herzen/dialog`)

This document describes the current scaffold of the local LLM response layer.

---

## Role

`@herzen/dialog` is the boundary between orchestration and LLM runtime.

- input: transcript + language hints + timestamp + optional short-term context items
- output: assistant reply text + metadata

`@herzen/core` should call this package and stay provider-agnostic.

---

## Current State

Implemented now:

- package scaffold (`src`, `tests`, scripts, exports)
- typed response domain model (`ResponseInput`, `ResponseOutput`, `ResponseError`)
- provider selection surface (`HERZEN_RESPONSE_PROVIDER`)
- Ollama config validation and local-only guardrails
- Ollama provider generation path (`POST /api/chat`, `stream: false`)
- context message injection (`conversationContext`) before current user transcript
- timeout/connection error mapping and output validation

Not implemented yet:

- tool/function calling
- persisted memory rehydration across process restarts
- streaming token output

---

## Environment Surface

- `HERZEN_RESPONSE_PROVIDER` (`ollama` default)
- `HERZEN_OLLAMA_BASE_URL` (`http://127.0.0.1:11434` default)
- `HERZEN_OLLAMA_MODEL` (required)
- `HERZEN_RESPONSE_TIMEOUT_MS` (default `12000`)
- `HERZEN_RESPONSE_TEMPERATURE` (default `0.2`)
- `HERZEN_ALLOW_REMOTE_LLM` (optional, default disabled)

Local-only policy:

- non-loopback `HERZEN_OLLAMA_BASE_URL` is rejected unless `HERZEN_ALLOW_REMOTE_LLM=1`

---

## Ollama Setup (MVP)

Recommended default model for this repo:

- `qwen2.5:3b`

Install Ollama (macOS/Homebrew):

```bash
brew install ollama
```

Verify CLI:

```bash
ollama --version
```

Pull model once:

```bash
ollama pull qwen2.5:3b
```

Quick runtime check:

```bash
ollama run qwen2.5:3b "Say hello"
```

Monitor loaded model/process status:

```bash
ollama ps
```

Run Herzen with dialog package enabled:

```bash
HERZEN_OLLAMA_MODEL=qwen2.5:3b pnpm dev
```

If local model warm-up is slow on first requests, increase timeout:

```bash
HERZEN_OLLAMA_MODEL=qwen2.5:3b HERZEN_RESPONSE_TIMEOUT_MS=60000 pnpm dev
```

---

## Public API (Scaffold)

- `createResponseService(options?)`
- `resolveResponseProvider(...)`
- `resolveOllamaConfig(...)`
- `createOllamaResponseService(...)`
- `buildMvpSystemPrompt(...)`
- `ResponseError` + `ResponseErrorCode`

---

## Error Model

- `CONFIG_INVALID`
- `RUNTIME_UNAVAILABLE`
- `GENERATION_FAILED`
- `OUTPUT_INVALID`

---

## Next Step

Extend beyond MVP reply generation (tools, memory, and richer response policies) while keeping local-first runtime guarantees.

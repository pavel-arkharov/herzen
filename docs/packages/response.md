# Response Package (`@herzen/response`)

This document describes the current scaffold of the local LLM response layer.

---

## Role

`@herzen/response` is the boundary between orchestration and LLM runtime.

- input: transcript + language hints + timestamp
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
- timeout/connection error mapping and output validation

Not implemented yet:

- tool/function calling
- memory/tool context injection
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

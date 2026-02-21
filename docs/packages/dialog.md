# Dialog Package (`@herzen/dialog`)

This document describes the current local LLM dialog implementation.

---

## Role

`@herzen/dialog` is the text-in/text-out reply boundary between `@herzen/core` and model runtimes.

- input: transcript + language hints + timestamp + optional short-term context items
- output: assistant reply text + provider metadata

`@herzen/core` calls this package and remains provider-agnostic.

---

## Current Implementation

Implemented now:

- typed response domain model (`ResponseInput`, `ResponseOutput`, `ResponseError`)
- provider selection surface (`HERZEN_RESPONSE_PROVIDER`, currently `ollama`)
- Ollama config validation with local-only endpoint guardrails
- non-streaming Ollama chat generation path (`POST /api/chat`, `stream: false`)
- context message injection (`conversationContext`) before current user transcript
- timeout/connection error mapping and strict output validation

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

## Ollama Setup

Recommended default model in this repo:

- `qwen2.5:3b`

```bash
ollama serve
ollama pull qwen2.5:3b
HERZEN_OLLAMA_MODEL=qwen2.5:3b pnpm dev
```

If local model warm-up is slow on first requests:

```bash
HERZEN_OLLAMA_MODEL=qwen2.5:3b HERZEN_RESPONSE_TIMEOUT_MS=60000 pnpm dev
```

---

## Public API

- `createResponseService(options?)`
- `resolveResponseProvider(...)`
- `resolveOllamaConfig(...)`
- `createOllamaResponseService(...)`
- `buildMvpSystemPrompt(...)`
- `resolveResponseLanguage(...)`
- `ResponseError` + `ResponseErrorCode`

---

## Error Model

- `CONFIG_INVALID`
- `RUNTIME_UNAVAILABLE`
- `GENERATION_FAILED`
- `OUTPUT_INVALID`

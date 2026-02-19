# Wakeword Sidecar Contract (Herzen <-> herzen-wake)

This document is the shared source of truth for wakeword integration between:

- `herzen` (main monorepo, Node/TypeScript)
- `herzen-wake` (separate daemon repo, Python/openWakeWord)
  - public repo: <https://github.com/pavel-arkharov/herzen-wake>

Goal: keep both repos implementable by separate agents without hidden assumptions.

---

## 1) Architecture Decision

Chosen approach for MVP:

- **Option 2**: persistent wakeword daemon process, started manually in terminal A
- Herzen runtime (`pnpm dev`) in terminal B
- Herzen connects to daemon over local IPC (Unix socket)

Not chosen by default:

- in-process wakeword model in Node
- service-account or cloud wakeword providers

Rationale:

- no service lock-in
- stable local process for better dev ergonomics
- keeps heavy detection runtime separate from core orchestration

---

## 2) Responsibility Split

### `herzen` repo responsibility

- maintain runtime/trigger abstractions
- consume wakeword events as `TriggerEvent`s
- map wakeword client failures to core `TriggerError` semantics
- continue with STT/TTS turn pipeline after trigger

### `herzen-wake` repo responsibility

- own microphone capture and openWakeWord inference
- own wakeword model loading and threshold/cooldown behavior
- expose detection events via local Unix socket protocol
- provide reliable lifecycle and shutdown behavior

---

## 3) IPC Transport

- transport: Unix domain socket
- encoding: UTF-8 newline-delimited JSON (JSONL)
- one JSON object per line
- MVP supports one active client connection at a time

### Socket path

Use explicit env var in both repos:

- `HERZEN_WAKEWORD_SOCKET`

Recommended default in Herzen when env is missing:

- `${dataRoot}/run/wakeword.sock`

`dataRoot` follows existing Herzen logic (`HERZEN_DATA_DIR` override else repo `data/`).

---

## 4) Message Protocol (Daemon -> Client)

All messages must include:

- `type` (string)
- `timestamp` (ISO 8601 string)

### `ready`

Sent once after connection is established and daemon is ready to stream detections.

Example:

```json
{"type":"ready","timestamp":"2026-02-14T10:00:00.000Z","version":"0.1.0","models":["herzen_v1"]}
```

### `wakeword`

Sent when threshold and cooldown conditions are satisfied.

Required fields:

- `keyword` (string)
- `score` (number)
- `threshold` (number)

Optional fields:

- `model` (string)

Example:

```json
{"type":"wakeword","timestamp":"2026-02-14T10:00:05.120Z","keyword":"herzen","score":0.82,"threshold":0.5,"model":"herzen_v1"}
```

### `heartbeat` (optional)

Optional liveness event (recommended every ~5s).

Example:

```json
{"type":"heartbeat","timestamp":"2026-02-14T10:00:10.000Z"}
```

### `error`

Fatal daemon-side runtime/protocol error. Should usually be followed by socket close.

Required fields:

- `code` (string)
- `message` (string)

Example:

```json
{"type":"error","timestamp":"2026-02-14T10:00:12.345Z","code":"MIC_FAILURE","message":"Input device disconnected"}
```

---

## 5) Client Behavior Rules (Herzen)

- wait for `ready` before considering source healthy
- deliver a trigger only on `wakeword` messages
- ignore `heartbeat`
- treat malformed JSON or invalid message shape as protocol failure
- if socket closes: terminal source-close behavior

### Mapping to core trigger errors

- socket closed cleanly -> `SOURCE_CLOSED`
- daemon `error` message -> `SOURCE_FAILED`
- protocol parse/validation failure -> `SOURCE_FAILED`
- connect timeout / refused / missing socket -> `SOURCE_FAILED`

---

## 6) Detection Policy (MVP)

- cooldown enforced in daemon (`HERZEN_WAKEWORD_COOLDOWN_MS`)
- no queueing in client: if no pending waiter, drop event
- one trigger should produce one core turn

Reason:

- predictable behavior with current single-turn core runtime
- avoids trigger backlog and accidental repeated turns

---

## 7) Performance and Reliability Targets

- idle CPU should remain low and stable
- average detection-to-trigger handoff should feel immediate (<300ms practical target)
- Ctrl+C shutdown must reliably release socket and mic handles
- Herzen restarts should reconnect without requiring daemon restart

---

## 8) Security and Hygiene

- socket is local-only (no public TCP port)
- remove stale socket file on daemon startup
- use restrictive socket permissions where supported
- never write raw transcript/audio data in wakeword protocol
- avoid storing secrets in git; use env vars (`.envrc` local only)

---

## 9) Local Dev Workflow

Terminal A (`herzen-wake`):

- start daemon once and keep it running

Terminal B (`herzen`):

- set `HERZEN_TRIGGER_MODE=wakeword`
- set matching `HERZEN_WAKEWORD_SOCKET`
- run `pnpm dev`

Expected result:

- wakeword triggers turns
- restarting `pnpm dev` does not require daemon restart

---

## 10) Change Management

If protocol changes are needed:

1. update this contract first
2. keep backward compatibility where practical
3. update both task prompts and tests in both repos in the same development window

# @herzen/core

## Runtime Settings Overrides

Core loads `data/control/runtime_settings.json` at startup and merges it into env before settings resolution:

1. base env: `process.env`
2. runtime overrides: `data/control/runtime_settings.json`
3. startup transient overrides (only when `HERZEN_STARTUP_INTERACTIVE=1`)

Merge order means persisted runtime overrides win over base env values.

## Settings Boundary

Precedence:

1. env / `.envrc`
2. `data/control/runtime_settings.json`
3. live control commands (session-local, in-memory only)

Current classification:

- `runtime` mutable: `runtime.profile`, `tui.user_name`, `logging.*`, `followup.*`, `control.allowed_scopes`, `ha.timeout_ms`
- `restart_required`: `ha.enabled`
- `profile_scoped`: `wakeword.set_enabled` / `voice.trigger_once` control behavior depends on active profile and trigger mode

`tui.user_name` maps to env key `USER_NAME` (default `USER`) and is consumed by TUI chat rendering for the user role label.

## Prompt Layering

For LLM conversational responses, core now passes layered prompt inputs into `@herzen/dialog`:

1. `kernelPrompt` (always set; default or override)
2. `personaPrompt` (optional; only when persona is enabled)
3. bounded conversation context (recent turns + summary slices)

Environment controls:

- `HERZEN_KERNEL_PROMPT` (preferred)
- `HERZEN_CONTEXT_KERNEL_PROMPT` (legacy compatibility)
- `HERZEN_PERSONA_ENABLED` (`0/1`, default disabled)
- `HERZEN_PERSONA_PROMPT` (used when persona is enabled)

## Runtime Profiles

Core supports three runtime profiles:

- `voice`: trigger loop enabled, chat ingress enabled
- `text`: trigger loop disabled, chat ingress only
- `hybrid`: trigger loop enabled, chat ingress enabled

Profile can be set by:

1. `HERZEN_RUNTIME_PROFILE` (env / runtime override file)
2. live control command `runtime.set_profile` (session-local, not persisted)

## Core Heartbeat

Core writes `data/control/core_status.json` with schema `core.status.v1`:

- `sessionId`
- `profile`
- `coreState` (`starting|ready|degraded|stopping`)
- `lastHeartbeatTs`
- `triggerState`
- `wakewordState`
- `sttState`
- `ttsState`
- optional `lastError`

TUI uses this heartbeat as the source of truth for online/offline state.

## Control Ingress (`control.ingress.v1`)

Core polls `data/control/ingress.jsonl` incrementally and accepts:

- `chat.send`
- `runtime.set_profile`
- `voice.trigger_once`
- `wakeword.set_enabled`
- `runtime.get_status`

Example `chat.send`:

```json
{
  "schemaVersion": "control.ingress.v1",
  "ingressId": "uuid",
  "sessionId": "session-id",
  "source": "tui",
  "command": "chat.send",
  "payload": {
    "sessionId": "session-id",
    "text": "hello",
    "source": "tui"
  },
  "ts": "2026-02-27T00:00:00.000Z"
}
```

`chat.send` ingress messages are routed through the same core path used by voice turns.
Runtime control commands emit structured execution outcomes (`accepted|applied|failed`) via `execution.jsonl`.

## Startup UX

Default `pnpm dev` startup is non-interactive.

- configure once: `pnpm --filter @herzen/core setup:interactive`
- run daily: `pnpm dev`
- optional legacy prompt mode: `HERZEN_STARTUP_INTERACTIVE=1 pnpm dev`

Startup now follows explicit phases:

- `BOOT_CONFIG_LOAD`
- `BOOT_CONFIG_VALIDATE`
- `BOOT_DEP_INIT`
- `BOOT_RUNTIME_START`
- `BOOT_READY`

On startup failure, core prints one structured fatal line with phase/code/remediation.

## Home Assistant Ownership Boundary

Core settings registry keeps cross-cutting HA knobs only:

- `ha.enabled`
- `ha.timeout_ms`

HA domain mapping knobs stay integration-owned in `@herzen/integration-homeassistant`:

- allowlisted lights
- light aliases
- scene aliases
- default light fallback

Core router now reuses integration intent parsing (`resolveHomeIntent`) instead of duplicating parsing/normalization logic.

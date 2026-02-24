# Home Assistant Integration (`@herzen/integration-homeassistant`)

This document covers:

1. setup
2. usage
3. deterministic intent model

---

## What It Is

`@herzen/integration-homeassistant` is a deterministic adapter from transcript text to Home Assistant API calls.

It is designed for safe local execution:

- constrained to allowlisted entities
- explicit alias mapping
- no free-form remote command generation

Current action support:

- `light.turn_on`
- `light.turn_off`
- `scene.turn_on`

---

## What It Is Not

- not a full natural-language planner
- not a generic tool-calling framework
- not an autonomous home-state reasoning engine
- not multi-action orchestration yet (single utterance -> single action)

---

## Setup

### 1) Enable HA integration

In local env (usually `/Users/parkharo/Programming/herzen/.envrc`):

```bash
export HERZEN_HA_ENABLED="1"
```

### 2) Configure secrets (recommended)

Use file-based secrets:

```bash
export HERZEN_HA_SECRETS_DIR="$HERZEN_ROOT/data/secrets/home_assistant"
```

Required files:

- `data/secrets/home_assistant/base_url`
- `data/secrets/home_assistant/token`

Permissions:

- token file should be owner-only (`chmod 600 data/secrets/home_assistant/token`)

Alternative:

- `HERZEN_HA_BASE_URL` and `HERZEN_HA_TOKEN` inline env vars (less secure)

### 3) Configure light scope and aliases

```bash
export HERZEN_HA_ALLOWED_LIGHTS="light.living_room,light.bedroom"
export HERZEN_HA_DEFAULT_LIGHT="light.living_room"
export HERZEN_HA_LIGHT_ALIASES="living room=light.living_room,гостиная=light.living_room,bedroom=light.bedroom,спальня=light.bedroom"
```

For grouped targets:

```bash
export HERZEN_HA_LIGHT_ALIASES="living room=light.living_room|light.ceiling|light.side_1"
```

### 4) Configure scene aliases

```bash
export HERZEN_HA_SCENE_ALIASES="bedroom read=scene.bedroom_read,bedroom reading=scene.bedroom_read,спальня чтение=scene.bedroom_read"
```

### 5) Reload env and run

```bash
direnv allow
pnpm dev
```

At startup, confirm:

- `Home Assistant integration: enabled.`

---

## Usage

Example utterances:

- `Herzen, living room lights on`
- `Herzen, спальня свет выключи`
- `Herzen, corridor nightlight`
- `Herzen, bedroom reading`

Behavior:

- if transcript matches an HA intent, Herzen executes HA action directly
- if transcript does not match, Herzen falls back to `@herzen/dialog` LLM reply

Current limitation:

- chained actions in one line are not executed sequentially yet

---

## Deterministic Intent Model

Execution path:

1. STT produces transcript
2. transcript normalization (language/punctuation tolerant)
3. intent resolution:
   - scene alias match first
   - then light on/off phrase + alias/entity match
4. strict allowlist validation
5. HA API call:
   - `POST /api/services/light/turn_on|turn_off`
   - `POST /api/services/scene/turn_on`
6. structured action result logged in conversation journal
7. short user-facing confirmation spoken by TTS

Why deterministic:

- predictable behavior
- safety for home actions
- easier debugging and audit

Long-term expected pattern:

- deterministic path remains primary
- LLM-assisted intent extraction can be added as fallback only
- fallback output must still be validated against allowlist/schema before execution

---

## Quick Terminal Check

Verify entities are visible from HA:

```bash
BASE_URL="$(tr -d '\r\n' < data/secrets/home_assistant/base_url)"
TOKEN="$(tr -d '\r\n' < data/secrets/home_assistant/token)"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/states" | jq '.[] | select(.entity_id|test("^(light|scene)\\.")) | .entity_id'
```


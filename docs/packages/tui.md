# @herzen/tui

Operator-focused terminal UI for monitoring and text ingress.

## Layout

The TUI renders 5 zones:

1. Header (app/version/session/model)
2. Tab strip (`Chat`, `Actions`, `Perf`, `Settings`)
3. Main panel content
4. Composer row (single-line input)
5. Footer status line (runtime state, pending flag, status message)

## Chat Composer and Ingress

- Enter: send composer text
- Esc: switch to normal mode
- Ctrl+C: quit

Composer send writes a `control.ingress.v1` `chat.send` event into:

- `data/control/ingress.jsonl`

The TUI never calls the LLM directly.
If core heartbeat is offline, send fails fast with a status message.

## Core Online Status

TUI reads `data/control/core_status.json` and uses heartbeat freshness as the online signal.

- Header shows `core=online|offline` and active `profile`.
- Chat panel shows current `coreState`, `triggerState`, and `wakewordState`.

## Panels

- `Chat`: chronological transcript with turn grouping and pending reply indicator.
- `Actions`: execution timeline from control execution stream with `started/succeeded/failed`.
- `Perf`: phase summary plus latest turn timing (`stt`, `llm`, `tts`, `e2e`) from benchmark stream.
- `Settings`: runtime-safe toggles sourced from core settings metadata.

## Keybindings

- Insert mode:
  - `Enter`: send composer text
  - `Esc`: switch to normal mode
- Normal mode:
  - `i`: switch to insert mode
  - `1` / `2` / `3` / `s`: panel switch
  - `v` / `t` / `h`: set profile (`voice` / `text` / `hybrid`)
  - `r`: `voice.trigger_once`
  - `w`: `wakeword.set_enabled` toggle
  - `j` / `k`: settings selection (settings panel)
  - `Enter`: apply selected setting (settings panel)
  - `q`: quit

## Runtime Settings Persistence

Settings overrides are persisted atomically to:

- `data/control/runtime_settings.json`

Core loads this file at startup and merges overrides into runtime env/settings resolution.

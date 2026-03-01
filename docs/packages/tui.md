# @herzen/tui

Operator-focused terminal UI for monitoring and text ingress.

## Layout

The TUI renders 5 zones:

1. Header (app/version/session/model)
2. Tab strip (`Chat`, `Actions`, `Perf`, `Settings`)
3. Main panel content
4. Composer row (single-line input)
5. Footer status line (runtime state, pending flag, status message)

In `Chat`, the main panel is split into:

1. pinned top frame: `Ingress` lifecycle + `Chat` runtime header
2. chat transcript body: line-wrapped and bottom-anchored in the remaining viewport

## Chat Composer and Ingress

Insert mode controls:

- `Enter`: send composer text
- `Esc`: switch to normal mode
- `Backspace`: delete one character
- `Ctrl+C`: quit

Composer send writes a `control.ingress.v1` `chat.send` event into:

- `data/control/ingress.jsonl`

The TUI never calls the LLM directly.
If core heartbeat is offline, send fails fast with a status message.

## Core Online Status

TUI reads `data/control/core_status.json` and uses heartbeat freshness as the online signal.

- Header shows `core=online|offline` and active `profile`.
- Chat panel shows current `coreState`, `triggerState`, and `wakewordState`.

## Panels

- `Chat`: chronological transcript with role labels and ingress source tags.
  - user role label comes from settings registry key `tui.user_name` (`USER_NAME`, fallback `USER`)
  - assistant role label is currently hardcoded as `Herzen`
  - voice/automation entries show turn grouping; TUI text ingress does not force turn separators
- `Actions`: execution timeline from control execution stream with `started/succeeded/failed`.
- `Perf`: phase summary plus latest turn timing (`stt`, `llm`, `tts`, `e2e`) from benchmark stream.
- `Settings`: runtime settings view sourced from core settings metadata.

## Keybindings

- Insert mode:
  - `Enter`: send composer text
  - `Esc`: switch to normal mode
- Normal mode:
  - `i`: switch to insert mode and jump to `Chat` tab
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

Current settings shown in TUI:

- `tui.user_name` (`USER_NAME`)
- `logging.level`
- `logging.transcript_enabled`
- `logging.perf_enabled`
- `followup.enabled`

Current inline editor behavior in Settings panel:

- booleans toggle on `Enter`
- `logging.level` cycles `info -> warn -> error -> info`
- non-boolean/non-cycled values are currently not edited inline

## Input and Rendering Notes

- Composer accepts Unicode printable input (including Cyrillic/CJK layouts).
- Chat lines are wrapped to viewport width; no right-edge truncation for long messages.

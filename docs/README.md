# Documentation

This directory contains durable project documentation for Herzen. Local task
prompts, audits, scratch notes, generated data, and model files are intentionally
kept out of git.

## Start Here

- [Design principles](design_principles.md)
- [Architecture overview](architecture/overview.md)
- [Package overview](packages/overview.md)
- [Testing approach](tests/testing_approach.md)
- [Beginner runbook](../runbook.md)

## Architecture

- [Overview](architecture/overview.md)
- [Wakeword sidecar contract](architecture/wakeword_sidecar_contract.md)
- [Control plane, intent, and context stack](architecture/v1_control_plane_intent_context.md)
- [Persona, kernel prompt, and context stack](architecture/persona_kernel_context_stack.md)

Related external repository:

- [`herzen-wake`](https://github.com/pavel-arkharov/herzen-wake), the wakeword daemon used by wakeword mode

## Packages

- [Package overview](packages/overview.md)
- [Core](packages/core.md)
- [Dialog](packages/dialog.md)
- [Home Assistant integration](packages/integration-homeassistant.md)
- [Speech-to-text](packages/stt.md)
- [Text-to-speech](packages/tts.md)
- [TUI](packages/tui.md)
- [Voice activity detection](packages/vad.md)

## Supporting Docs

- [Hardware strategy](hardware/strategy.md)
- [Task execution strategy](process/task_execution_strategy.md)

# Testing Approach and Setup

This document defines how testing works in this repository today, and how to run test commands correctly.

## Scope and goals

Current test scope is unit tests for the monorepo packages:

- `/Users/parkharo/Programming/herzen/packages/core`
- `/Users/parkharo/Programming/herzen/packages/audio`
- `/Users/parkharo/Programming/herzen/packages/stt`
- `/Users/parkharo/Programming/herzen/packages/tts`
- `/Users/parkharo/Programming/herzen/packages/vad`
- `/Users/parkharo/Programming/herzen/packages/wakeword`
- `/Users/parkharo/Programming/herzen/packages/dialog`

Primary goals:

- catch regressions in trigger logic and runtime orchestration
- validate command-wrapper behavior for audio and TTS modules
- validate whisper.cpp command wiring, output parsing, and STT error behavior
- validate adaptive recording and VAD integration behavior
- validate file-transcription CLI argument handling and document output generation
- keep tests fast and deterministic (no real audio hardware needed)

## Tooling

- Test runner: `vitest`
- Coverage provider: `@vitest/coverage-istanbul`
- Config file: `/Users/parkharo/Programming/herzen/vitest.config.mts`

## Test layout

Tests live in `tests/` folders inside each package:

- `/Users/parkharo/Programming/herzen/packages/core/tests`
- `/Users/parkharo/Programming/herzen/packages/audio/tests`
- `/Users/parkharo/Programming/herzen/packages/stt/tests`
- `/Users/parkharo/Programming/herzen/packages/tts/tests`
- `/Users/parkharo/Programming/herzen/packages/vad/tests`
- `/Users/parkharo/Programming/herzen/packages/wakeword/tests`
- `/Users/parkharo/Programming/herzen/packages/dialog/tests`

Naming convention:

- `*.test.ts` files

## Where to run commands

Unless explicitly noted otherwise, run all commands from the repository root:

- `/Users/parkharo/Programming/herzen`

## Commands

From `/Users/parkharo/Programming/herzen`:

```bash
# run all tests once
pnpm test

# watch mode for all tests
pnpm test:watch

# run tests with coverage
pnpm test:coverage

# run package-specific suites
pnpm test:core
pnpm test:audio
pnpm test:stt
pnpm test:tts
pnpm test:wakeword
pnpm test:dialog
pnpm --filter @herzen/vad test

# quality gates used alongside tests
pnpm lint
pnpm typecheck
```

Optional package-local execution (from package directory):

- `/Users/parkharo/Programming/herzen/packages/core`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/audio`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/stt`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/tts`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/vad`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/wakeword`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/dialog`: `pnpm test`

## Test design guidance

- Prefer unit tests with dependency injection and mocks over integration-style process tests.
- Mock `node:child_process` for audio/TTS tests to avoid shelling out to `rec`, `play`, `say`.
- For trigger-source tests, mock readline/stderr/stdin events and assert typed error codes.
- For VAD tests, use fake ORT/session/tensor doubles instead of loading real ONNX models.
- For wakeword client tests, use socket test doubles and JSONL message fixtures (no real daemon process).
- Keep tests behavior-focused:
  - success path
  - expected failure path
  - terminal/error path

## Current covered areas

- Trigger mode resolution and source factory selection
- Trigger error typing and guards
- Stdin trigger source normal + terminal error paths
- Runtime loop orchestration branches (`SOURCE_CLOSED`, `SOURCE_FAILED`)
- STT/core trigger-turn orchestration (`createSttTriggerHandler`) including:
  - transcript success path
  - empty-transcript fallback speech
  - fixed vs adaptive recording mode branching
  - adaptive failure fallback to fixed recording
  - typed and unknown STT failure handling
  - STT log entry shape and playback toggle behavior
- Audio command wrapper arguments and process error handling
- Audio adaptive endpointing stop conditions (`trailing_silence`, `max_seconds`, `no_speech_timeout`)
- Audio adaptive error paths (config validation, rec exit failures, stderr propagation)
- STT binary/model/env validation + transcription parse and fallback paths
- STT file-transcription CLI argument parsing and usage error handling
- STT document rendering and write-path behavior (`txt` and `md`)
- STT `.m4a` conversion path behavior (`ffmpeg` primary, `afconvert` fallback)
- TTS language-tag/cyrillic inference branches and process error handling
- VAD model-path/runtime config validation and session probability semantics
- VAD ONNX engine behavior for recurrent state inputs/outputs (`h`, `c`, `hn`, `cn`)
- Wakeword socket client lifecycle, protocol parsing, and error semantics
- Response package config validation and provider-boundary scaffold behavior

## Known gaps

- No end-to-end test currently executes the full core runtime loop against real local tools (`rec`, `play`, `say`, `whisper.cpp`).
- No end-to-end test currently exercises adaptive recording against a real Silero ONNX model in the core loop.
- No end-to-end test currently validates wakeword-triggered turns against a live `herzen-wake` daemon.

## Adding new tests

When adding features:

1. Add or update tests in the same package and same PR.
2. Focus first on new branching logic and boundary behavior.
3. Run from repo root:
   - `pnpm test`
   - `pnpm lint`
   - `pnpm typecheck`
4. If logic changes materially, run `pnpm test:coverage` and inspect gaps.

## Notes

- Coverage output is generated in `coverage/` (gitignored).
- Keep tests independent from local data artifacts in `/data`.

# Testing Approach and Setup

This document defines how testing works in this repository today, and how to run test commands correctly.

## Scope and goals

Current test scope is unit tests for the monorepo packages:

- `/Users/parkharo/Programming/herzen/packages/core`
- `/Users/parkharo/Programming/herzen/packages/audio`
- `/Users/parkharo/Programming/herzen/packages/stt`
- `/Users/parkharo/Programming/herzen/packages/tts`

Primary goals:

- catch regressions in trigger logic and runtime orchestration
- validate command-wrapper behavior for audio and TTS modules
- validate whisper.cpp command wiring, output parsing, and STT error behavior
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

# quality gates used alongside tests
pnpm lint
pnpm typecheck
```

Optional package-local execution (from package directory):

- `/Users/parkharo/Programming/herzen/packages/core`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/audio`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/stt`: `pnpm test`
- `/Users/parkharo/Programming/herzen/packages/tts`: `pnpm test`

## Test design guidance

- Prefer unit tests with dependency injection and mocks over integration-style process tests.
- Mock `node:child_process` for audio/TTS tests to avoid shelling out to `rec`, `play`, `say`.
- For trigger-source tests, mock readline/stderr/stdin events and assert typed error codes.
- Keep tests behavior-focused:
  - success path
  - expected failure path
  - terminal/error path

## Current covered areas

- Trigger mode resolution and source factory selection
- Trigger error typing and guards
- Stdin trigger source normal + terminal error paths
- Runtime loop orchestration branches (`SOURCE_CLOSED`, `NOT_IMPLEMENTED`, `SOURCE_FAILED`)
- Audio command wrapper arguments and process error handling
- STT binary/model/env validation + transcription parse and fallback paths
- TTS language-tag/cyrillic inference branches and process error handling

## Known gaps

- Current core runtime tests do not exercise the STT transcription path.

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

# Agent Operating Notes

This file defines repository-level defaults for coding agents working in this project.

## Task Lifecycle Rules (Mandatory)

- Use `/Users/parkharo/Programming/herzen/docs/tasks/` for active local task tickets/prompts.
- Keep `/Users/parkharo/Programming/herzen/docs/tasks/` focused on active work only.
- When the user confirms a task is complete:
  1. Verify acceptance criteria and run listed verification commands.
  2. Move durable outcomes/decisions into tracked docs (README, package docs, architecture/process docs).
  3. Remove the completed task `.md` file from `/Users/parkharo/Programming/herzen/docs/tasks/`.
- Do not treat `/Users/parkharo/Programming/herzen/docs/tasks/` as permanent documentation; it is intentionally gitignored.

## Task Prompt Quality Baseline

Task files should include:

- Goal
- Current state
- Scope in
- Scope out
- Acceptance criteria
- Verification commands
- Delivery format

## Source of Truth

For full process guidance, see:

- `/Users/parkharo/Programming/herzen/docs/process/task_execution_strategy.md`

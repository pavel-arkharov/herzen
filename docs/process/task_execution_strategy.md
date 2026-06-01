# General Task Execution Strategy

Use this as the shared playbook for local task prompts in `docs/tasks/`.

## Why this exists

Keep task work consistent, small, and verifiable.
Treat task files like lightweight local tickets.

## Task file quality bar

Each task file should include:

- `Goal`: one clear outcome.
- `Current state`: short baseline of what exists now.
- `Scope in`: exact files/areas allowed.
- `Scope out`: what must not be changed.
- `Acceptance criteria`: behavior-level checklist.
- `Verification commands`: exact commands to run.
- `Delivery format`: what the agent should report back.

## Execution rules

- Prefer small increments with checkpoints.
- Preserve existing behavior unless the task explicitly changes it.
- Avoid broad refactors unless required for the task goal.
- If blocked, ask only the minimum question, then continue.
- Record assumptions explicitly in task output.

## Lifecycle states

Use one state per task file:

- `Planned`: drafted, not yet assigned.
- `In progress`: currently being implemented.
- `Blocked`: waiting on decision/dependency.
- `Done`: implemented and validated.

## Completion protocol

When a task is complete:

1. Confirm acceptance criteria and verification outputs.
2. Move durable decisions into tracked docs (README/package docs/architecture/process), if relevant.
3. Remove the completed task `.md` file from `docs/tasks/` when the user confirms completion.

This keeps the task folder focused on active work only.

## Optional naming convention

Use predictable task names:

- `feature_<topic>.md`
- `fix_<topic>.md`
- `audit_<topic>.md`
- `refactor_<topic>.md`

## Practical note

`docs/tasks/` is gitignored on purpose.
These files are local execution aids, not permanent project documentation.

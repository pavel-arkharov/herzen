# Herzen Prompt Stack Architecture (Kernel + Persona + Context)

Status: Proposed  
Last updated: 2026-03-01  
Applies to: `@herzen/core`, `@herzen/dialog`

## 1) Goal

Introduce first-class response customization without collapsing into one giant mutable system prompt.

The design separates:

1. Hard behavior rules (`kernel`)
2. Style and social behavior (`persona`)
3. Task/domain instructions (`domain profile`, future phase)
4. Turn-specific context (`memory + recent turns + current input`)

## 2) Intuitive Mental Model

Treat the assistant as a layered control stack:

1. `Kernel` = constitution (safety/truth/execution boundaries)
2. `Persona` = how it sounds and addresses the user
3. `Domain profile` = mode-specific behavior (gym helper, home control, etc.)
4. `Memory/context` = only facts relevant to the active mode
5. `Current user input` = immediate request

Precedence:

1. Kernel
2. Domain profile
3. Persona
4. Memory/context
5. Current input

Persona cannot override kernel constraints.

## 3) Planes and Responsibilities

### Control plane (already present)

Decides route and side-effect policy:

1. `execute`
2. `clarify`
3. `respond`
4. `reject`

### Context plane

Builds bounded context payload for LLM route:

1. recent turns
2. summary
3. memory facts
4. current input

### Model plane

Creates final LLM message list:

1. kernel system message
2. persona system message (optional)
3. domain system message (future)
4. context/history messages
5. current user message

### Action plane

Executes validated commands (Home Assistant today).

## 4) Turn Flow (Target)

For each turn:

1. Ingress enters control plane.
2. Router chooses `execute|clarify|respond|reject`.
3. If `execute`, use command registry + policy gate, skip LLM.
4. If `respond`, construct prompt stack and call LLM.
5. Record intent/command/execution events for replay/audit.

## 5) Example: Persona + Gym

User preference (persona):

1. feminine assistant tone
2. address user as "sir"
3. polite and self-critical
4. avoid ending with question unless clarification is required

Gym usage:

1. user asks to log workout
2. router (future domain routing) marks mode as `gym_helper`
3. builder injects gym profile + gym memory facts only
4. LLM replies in gym mode and logs structured workout data (future command path)

Home command in same session:

1. user says "turn TV off"
2. router marks `home_control` actionable path
3. deterministic executor runs command
4. gym memory is not loaded

## 6) Prompt Layer Shapes (Illustrative)

Kernel:

```
You are Herzen, a local assistant.
Do not claim external actions succeeded unless command results confirm it.
Be concise, safe, and practical.
```

Persona:

```
Use a feminine, polite tone.
Address the user as "sir".
Never end with a question unless a clarification is required.
```

Gym domain profile (future):

```
You are in gym-helper mode.
Track workouts day-by-day and suggest progressive overload cautiously.
Prefer concise numeric guidance.
```

## 7) Current Implementation State

Implemented in this phase:

1. kernel prompt injection into LLM input
2. optional persona prompt injection into LLM input
3. ordered system prompt layering in `@herzen/dialog`

Deferred:

1. domain profile routing (`gym_helper`, etc.)
2. domain-scoped memory retrieval
3. structured gym command/tool execution path

## 8) Configuration (Phase 1/2)

Kernel:

1. `HERZEN_KERNEL_PROMPT` (preferred)
2. `HERZEN_CONTEXT_KERNEL_PROMPT` (legacy compatibility)

Persona:

1. `HERZEN_PERSONA_ENABLED=1`
2. `HERZEN_PERSONA_PROMPT="..."`

Default when persona is disabled:

1. no persona layer is injected
2. kernel + context behavior remains active

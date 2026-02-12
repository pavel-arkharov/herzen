# Herzen — Design Intent & Architectural Rationale

## Purpose

Herzen is a **local-first, always-on personal voice assistant**.

Its primary goal is not to be maximally capable, fast, or clever, but to be:

- present
- reliable
- calm
- owned by the user

Herzen is designed as _domestic software_:  
software that lives in a home, accumulates memory slowly, and respects the rhythms and boundaries of human life.

This document describes the **intentions behind the project** and the **architectural decisions made so far**, so that future changes can be evaluated against first principles rather than convenience.

---

## Non-goals (explicit)

Herzen is **not** intended to be:

- a cloud service
- a SaaS product
- a general-purpose chatbot
- a productivity dashboard
- a replacement for human judgment

Herzen does not aim to:

- maximize engagement
- collect telemetry
- require accounts
- depend on external APIs to function

Capabilities may grow, but these constraints are intentional and foundational.

---

## Core principles

### 1. Local-first by default

All essential functionality must work **without network access**.

This includes:

- voice input
- voice output
- reasoning
- memory storage
- interaction with local tools

Networking, synchronization, or remote access (if added later) must be _additive_, not foundational.

**Rationale:**  
Local-first architecture restores user ownership, reduces fragility, and allows the system to remain useful even when infrastructure fails.

---

### 2. The assistant is a _process_, not a product

Herzen runs as a **long-lived local process**.

It has:

- idle states
- active states
- memory over time
- a physical location (a machine, a room)

This is fundamentally different from request–response systems.

**Rationale:**  
Presence requires continuity.  
A system that is constantly restarted, re-authenticated, or re-contextualized cannot feel calm or trustworthy.

---

### 3. Modularity over cleverness

The system is decomposed into small, explicit modules:

- audio I/O
- orchestration (core)
- wake word detection
- speech-to-text
- text-to-speech
- integrations

Each module:

- has one responsibility
- can be replaced independently
- communicates via simple interfaces

**Rationale:**  
This reduces cognitive load, avoids lock-in to specific technologies, and allows gradual improvement without rewrites.

---

## Why a monorepo

Herzen uses a **pnpm monorepo**.

This allows:

- shared tooling and types
- clear boundaries between subsystems
- atomic changes across packages
- a single source of truth for architecture

The monorepo is an _implementation detail_, not a product decision.

**Rationale:**  
Early-stage systems benefit from proximity and coherence more than artificial separation.

---

## Why Node.js for the core (for now)

The assistant core is implemented in **Node.js / TypeScript**.

This choice is pragmatic, not ideological.

Node is used for:

- orchestration
- state machines
- process control
- file system interaction
- integration glue

Heavy computation (ML models) is explicitly _not_ embedded in the core.

**Rationale:**  
The core’s job is coordination, not intelligence.  
Using a flexible, well-understood runtime minimizes friction during early exploration.

This does not preclude:

- native Swift components
- Python-based ML services
- future refactoring

---

## Why audio is file-based initially

Early audio handling uses:

- short WAV files
- CLI tools (`sox`, `say`)
- blocking execution

This is intentionally simple.

**Rationale:**  
File-based audio is:

- debuggable
- inspectable
- easy to reason about
- sufficient for early correctness

Streaming audio will be introduced only when required by real constraints (latency, concurrency).

---

## The wake word as a boundary

The wake word is treated as a **hard boundary** between:

- ambient listening
- intentional interaction

Herzen must never behave as if it is “always interpreting”.

**Rationale:**  
A clear invocation boundary preserves:

- privacy
- psychological safety
- predictability

The wake word is a design decision, not merely a technical one.

---

## Text-to-speech as embodiment

Voice output is not a cosmetic feature.

It is the assistant’s **body**.

TTS choices are evaluated based on:

- stability
- controllability
- local execution
- emotional neutrality

Voice cloning (including the user’s own voice) is treated as an advanced feature with ethical and psychological implications.

**Rationale:**  
Speech creates presence. Presence creates responsibility.

---

## Memory as files, not vectors (initially)

Herzen prefers:

- plain text
- Markdown
- append-only logs
- human-readable formats

Vector databases, embeddings, or opaque stores may be added later, but never as the sole memory.

**Rationale:**  
Human memory is inspectable.  
Software memory should be as well.

---

## Design stance toward AI models

AI models are treated as **tools**, not authorities.

They:

- propose
- summarize
- generate drafts
- assist decision-making

They do not:

- own memory
- define truth
- override explicit user intent

**Rationale:**  
The system must remain legible and corrigible.

---

## Evolution strategy

Herzen is designed to evolve by:

1. Building a minimal, working loop
2. Living with it
3. Identifying friction
4. Refining one layer at a time

There is no fixed roadmap beyond this.

**Rationale:**  
Long-lived personal software must adapt to its user, not the other way around.

---

## Summary

Herzen is an experiment in:

- local-first architecture
- humane software
- long-running personal systems
- calm interaction models

Architectural decisions are guided by:

- ownership
- continuity
- simplicity
- respect for human attention

Any future change should be evaluated against these principles.

If a feature increases capability but reduces calm, ownership, or legibility, it is likely a mistake.

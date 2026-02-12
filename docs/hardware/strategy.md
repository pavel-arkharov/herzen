# Herzen — Hardware Strategy

This document summarizes the **hardware approach** for the Herzen project:
what is used now, why those choices were made, what constraints exist,
and how the system is expected to evolve over time.

The goal is not to define a single “ideal” machine, but to describe a **hardware philosophy**
that supports local-first, always-on, domestic software.

---

## Design goals (hardware)

Herzen’s hardware should be:

- local and user-owned
- quiet and unobtrusive
- power-efficient
- reliable over long runtimes
- capable of running modern local ML workloads
- simple enough to maintain without becoming a hobby in itself

Hardware is treated as **infrastructure**, not as a performance playground.

---

## Current development setup

### Primary development machine

- **MacBook Pro (M1, 16 GB RAM, 512 GB SSD)**

Used for:

- writing code
- iterating on architecture
- short-lived test runs
- early prototyping of audio, orchestration, and logic

Constraints:

- limited internal storage
- not suitable for always-on operation
- thermal and power considerations
- context-switching between “work laptop” and “domestic assistant”

This machine is sufficient for early development, but **not intended to be the long-term host** of the assistant.

---

## Target always-on host (planned)

### Intended role

A dedicated, always-on machine that acts as the **“house brain”**:

- runs the assistant core continuously
- handles wake word detection
- performs speech-to-text and text-to-speech
- hosts local models
- integrates with home devices
- optionally serves as a media hub

### Preferred class of device

- **Apple Silicon Mac mini (M-series)**

Rationale:

- excellent performance-per-watt
- strong local ML acceleration
- silent operation
- stable macOS audio stack
- same architecture as the development machine (low friction)
- long expected lifespan

### Expected baseline configuration

- **16 GB RAM**
- **256 GB internal SSD**
- **external SSD for models and data (initially)**

This configuration is considered _sufficient_ for:

- wake word detection
- Whisper-class STT
- small-to-medium local LLMs (quantized)
- local TTS (including voice cloning inference)
- Home Assistant–level integrations

---

## Storage strategy

### Short term

- External USB-C SSD for:
  - ML models
  - audio datasets
  - logs
  - TTS training data
- Internal SSD reserved for:
  - OS
  - code
  - configuration

This allows:

- delaying internal SSD upgrades
- minimizing cost
- reducing risk while the system is still evolving

### Long term

- Internal SSD upgrade (e.g. 256 GB → 2 TB), if/when:
  - multiple models are stored simultaneously
  - voice datasets grow significantly
  - the system runs continuously without manual cleanup
  - mental overhead of storage management becomes noticeable

The upgrade is considered **convenience-driven**, not mandatory.

---

## RAM considerations

### Current stance

- **16 GB RAM is acceptable** for the intended scope.

This assumes:

- use of quantized models
- inference-first workloads (not large-scale training)
- sequential or lightly concurrent processing
- conscious resource management

### When more RAM might be justified

- larger local LLMs (13B+)
- multi-user or multi-room assistants
- concurrent STT + LLM + TTS pipelines
- longer conversational context windows

Until those needs are real, additional RAM is intentionally deferred.

---

## Audio hardware

### Current state

- Built-in laptop microphone
- System speakers or headphones

This is sufficient for:

- early wake word experimentation
- STT testing
- pipeline correctness

### Future direction

- fixed-position room microphone
- consistent distance and orientation
- predictable noise profile

The goal is **reliability**, not studio quality.

Microphone upgrades are driven by:

- false wake-ups
- missed wake-ups
- frustration in daily use

Not by audio perfectionism.

---

## GPU / accelerators

No dedicated GPU is required initially.

Apple Silicon’s:

- CPU
- Neural Engine
- unified memory

are sufficient for:

- STT
- TTS
- small-to-medium LLM inference

Discrete GPUs are considered **out of scope** unless future requirements clearly justify the complexity.

---

## Hardware evolution philosophy

Herzen’s hardware strategy follows these rules:

1. **Delay purchases until friction is felt**
2. **Prefer fewer, quieter machines**
3. **Avoid “temporary cloud” solutions**
4. **Upgrade only to reduce mental load**
5. **Treat hardware as long-lived infrastructure**

The system should feel _settled_, not experimental.

---

## Summary

- Development starts on a laptop
- Always-on operation moves to a dedicated local machine
- Apple Silicon is the preferred platform
- External storage buys time and flexibility
- RAM and SSD upgrades are deferred until genuinely needed
- Audio hardware evolves from “good enough” to “reliable”

Hardware decisions are made in service of:

- calm
- ownership
- continuity
- long-term use

Performance for its own sake is not a goal.

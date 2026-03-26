# Project Ariadne (VR Discussion Facilitator) — System Architecture Document

> **Status:** Living document. Updated as subsystems are designed and built.
> **Audience:** AI code agents and human engineers working on any part of this system.
> **Scope:** High-level architecture. Fine-grained implementation details are determined per session.

---

## 1. Project Overview

Project Ariadne is an LLM-powered discussion facilitator that operates as an AI participant inside a multiplayer VR world (e.g., VRChat-style). It perceives the conversation through live audio streams from all players, interprets world state from a structured environment feed, and participates by speaking through a TTS model and controlling an in-world avatar.

Ariadne is designed to support natural, low-latency conversational interaction while also providing thoughtful, strategic facilitation — achieved through a dual-agent architecture: a fast **Talker** and a slower **Reasoner**.

The system will be built primarily in **TypeScript**, including orchestration, service boundaries, shared schemas, and subsystem interfaces unless a specific component has a clear reason to use another language.

---

## 2. System Architecture

### 2.1 Architectural Pattern: Talker-Reasoner

Ariadne follows the **Talker-Reasoner** dual-agent pattern, inspired by Kahneman's System 1/System 2 cognitive model and formalised in DeepMind's 2024 paper of the same name.

- The **Talker** (System 1) is a fast, small-to-medium LLM. It reacts to conversation events in near real-time, producing speech and reactive avatar commands.
- The **Reasoner/Thinker** (System 2) is a capable, slower LLM. It runs periodically (~every 60 seconds) or on-demand, analyses the full conversation and world state, and updates a shared belief store with strategic guidance for the Talker. **Note:** the architecture literature refers to this agent as the "Reasoner"; the codebase uses "Thinker" throughout.
- Both agents communicate primarily through a **Shared Belief Store**. The Reasoner/Thinker writes; the Talker reads.

### 2.2 High-Level Data Flow

```
[Player Audio x N] ──► [Streaming STT + Speaker ID] ──┐
[VR World State]   ──► [World State Summariser]        ├──► [Event Bus]
                                                        │
                    ┌───────────────────────────────────┘
                    ▼
             [Event Router]
             /             \
     [Talker Model]    [Reasoner Model]
            |    \           |
            |     └──trigger──┘
            |
     reads ◄──── [Shared Belief Store] ◄──── writes
            |
            ▼
   [TTS Engine]   [Avatar Controller]
```

### 2.3 Repository Structure

The codebase should be organised in a monorepo-like structure, with each major subsystem owning its own folder or package. This keeps runtime concerns, deployment boundaries, and interface contracts explicit.

**Actual layout (as built):**

- `apps/web` — Next.js control panel
- `apps/server` — Node.js orchestration server
- `packages/shared-contracts` — TypeScript types and Zod schemas
- `packages/chat-providers` — OpenRouter and Cerebras chat providers
- `packages/talker` — Talker agent (System 1)
- `packages/thinker` — Thinker agent (System 2, called "Reasoner" in the pattern literature)
- `packages/shared-belief-store` — Valkey-backed belief store
- `packages/event-bus` — In-process event routing
- `packages/tts-client` — Deepgram TTS streaming integration

Shared TypeScript types and schemas live in `packages/shared-contracts` so that event definitions, belief store structures, and command contracts remain versioned in one place.

---

## 3. Subsystems

### 3.1 Input Pipeline

**Responsibilities:**

- Receive raw audio streams from all players simultaneously.
- Run per-player streaming Speech-to-Text (STT) with speaker diarisation, tagging each transcript chunk with a speaker identity.
- Detect turn boundaries (utterance end) using a Voice Activity Detector (VAD).
- Periodically poll the VR environment for world state and produce a compact structured summary.

**Outputs to Event Bus:**

- `UtteranceChunk` — partial in-progress transcript (for streaming awareness)
- `UtteranceFinal` — completed turn transcript with speaker ID and timestamp
- `WorldStateUpdate` — structured summary of current environment state

**Notes:**

- Speaker identity should be a stable identifier consistent across sessions.
- World state updates should include: player positions and proximity, ongoing activities or interactions, scene/room context, and any state flags relevant to the discussion (e.g., a shared whiteboard being active).

---

### 3.2 Event Bus

**Responsibilities:**

- Acts as the central message broker for all events in the system.
- Delivers events to the Talker immediately.
- Delivers events to the Reasoner's context accumulator on its own schedule.

**Key Event Types:**

| Event | Producer | Consumer(s) |
| --- | --- | --- |
| `UtteranceChunk` | Input Pipeline | Talker |
| `UtteranceFinal` | Input Pipeline | Talker, Reasoner context buffer |
| `WorldStateUpdate` | Input Pipeline | Talker (as context), Reasoner |
| `ReasonerComplete` | Reasoner | Talker (wake / update signal) |
| `TalkerWaitFlag` | Talker | Reasoner (early trigger) |
| `AvatarCommand` | Talker, Reasoner | Avatar Controller |

---

### 3.3 Shared Belief Store

**Responsibilities:**

- Serves as the persistent, structured memory shared between the Talker and Reasoner.
- The Reasoner holds write authority. The Talker reads only.
- Persists across Reasoner cycles; represents the Reasoner's current understanding of the conversation.

**Schema (to be fully defined):**
The belief store schema will be defined as part of a dedicated design session. At minimum, it should capture:

- `participants` — per-player model: speaking frequency, current stance/topic, emotional tone, engagement level
- `discussion_state` — current topic, discussion phase (e.g., brainstorm, debate, convergence), key open questions
- `facilitation_plan` — the Reasoner's current strategic intent (e.g., "encourage quieter participants", "redirect off-topic thread")
- `directive_queue` — ordered list of specific instructions for the Talker to execute (text to say, actions to take)
- `conversation_summary` — a rolling compressed summary of conversation history, managed by the Reasoner

**Notes:**

- The belief store should be readable as a single structured prompt fragment, so the Talker can include it in its context without special parsing.
- Versioning or timestamping entries is recommended so the Talker can detect staleness.

---

### 3.4 Talker Model (System 1)

**Responsibilities:**

- React to incoming utterance events in near real-time.
- Produce conversational speech and reactive avatar commands.
- Decide whether to respond immediately or wait for the Reasoner.
- Flag complex situations to the Reasoner for early invocation.

**Context Window (at inference time):**

- Last N turns of conversation (recent window only)
- Current belief store snapshot (read from Shared Belief Store)
- Pending entries from the directive queue
- Current world state summary

**Tool Calls available to Talker:**

- `speak(text)` — emits text to the TTS engine for immediate playback
- `avatar_command(command)` — sends a command to the Avatar Controller (see Section 3.6)
- `trigger_reasoner(reason)` — flags the Reasoner for early invocation with a reason string
- `wait_for_reasoner()` — blocks the Talker's response until the Reasoner completes its next cycle
- `read_belief_store()` — fetches the latest belief store snapshot
- `dequeue_directive()` — pops the next item from the directive queue

**Talker Wait Triggers:**
The Talker must call `wait_for_reasoner()` before responding when any of the following conditions are met:

- The directive queue is non-empty (the Reasoner has queued a specific next action)
- A player explicitly asks for a summary, synthesis, or decision
- The Talker has just called `trigger_reasoner()` and the nature of the situation requires a thoughtful response (not a filler acknowledgement)
- A significant world state change has just occurred (e.g., players have moved to a new area)

In all other cases, the Talker proceeds with the most recent available belief state, accepting mild staleness in exchange for low latency.

---

### 3.5 Thinker Model (System 2)

> **Note:** This agent is called "Thinker" in the codebase and "Reasoner" in the academic pattern. The terms refer to the same component.

**Responsibilities:**

- Perform deep analysis of the full conversation history and world state.
- Update the Shared Belief Store with refined participant models, discussion state, and facilitation strategy.
- Produce directives for the Talker (specific speech or actions).
- Summarise and compact conversation history to manage context growth.

**Invocation:**

- **Periodic:** Every ~60 seconds by default.
- **On-demand:** When the Talker calls `trigger_reasoner()` or `wait_for_reasoner()`.

**Context Window (at inference time):**

- Full conversation history (or compacted version for older segments)
- Current world state summary
- Current belief store (as a starting point for updating)

**Tool Calls available to Reasoner:**

- `write_belief_store(updated_store)` — overwrites the belief store with the new version
- `enqueue_directive(directive)` — pushes a specific instruction onto the Talker's directive queue
- `avatar_command(command)` — sends a planned avatar command (e.g., repositioning) to the Avatar Controller
- `compact_history(up_to_timestamp)` — triggers summarisation of conversation history older than a given point, storing the result in the belief store summary field
- `read_world_state()` — fetches the latest world state summary

**Reasoner Output Responsibilities:**
After each cycle, the Reasoner must at minimum:

1. Write an updated belief store (even if no material changes).
2. Clear fulfilled directives from the queue.
3. Compact history if the conversation history exceeds a defined token threshold.

---

### 3.6 Avatar Controller

> **Ownership:** This subsystem is owned by a separate team. The spec below defines the interface contract that the AI system will rely on.

**Responsibilities:**

- Translate structured avatar commands into in-world avatar behaviour in the VR environment.
- Manage a command priority and interrupt system (Reasoner-planned behaviours can be overridden by Talker reactive commands).
- Expose a stable command API for both the Talker and Reasoner to call via `avatar_command(command)`.

**Command Schema (to be finalised with Avatar Controller team):**
All commands should be expressible as a structured object with at least:

- `type` — one of a finite, agreed-upon command vocabulary (see below)
- `target` — optional reference to a player or world object
- `priority` — `reactive` (from Talker, high interrupt priority) or `planned` (from Reasoner, lower interrupt priority)
- `parameters` — type-specific arguments

**Command Vocabulary (draft):**

| Command Type | Description | Example Parameters |
| --- | --- | --- |
| `gaze` | Direct avatar eye gaze toward a target | `{ target: player_id }` |
| `gesture` | Play a named gesture animation | `{ name: "nod" \| "wave" \| "point" \| ... }` |
| `expression` | Set a facial expression | `{ name: "neutral" \| "thinking" \| "attentive" \| ... }` |
| `move_to` | Navigate avatar to a position or near a target | `{ target: player_id \| position_id }` |
| `idle` | Return to default idle behaviour | — |

**Priority System:**

- `reactive` commands from the Talker (e.g., gaze shifts, nods) interrupt any in-progress `planned` behaviour.
- `planned` commands from the Reasoner (e.g., moving to a new area) execute when no higher-priority command is pending.
- The Avatar Controller queues `planned` commands and executes them opportunistically between reactive commands.

---

### 3.7 TTS Engine

**Responsibilities:**

- Accept text from the Talker's `speak()` tool call and synthesise audio output for the AI's voice in the VR space.
- Support **streaming synthesis** (text-in, audio-out in chunks) to minimise time-to-first-audio.
- Spatialise the output audio from the AI avatar's in-world position.

**Interface:**

- Input: text string (may arrive in streaming token chunks)
- Output: audio stream, routed to the VR spatial audio system

**Notes:**

- The TTS engine should expose a cancellation/interrupt API so that if a player begins speaking over the AI, the Talker can cut playback short.
- Voice characteristics (tone, pace) may eventually be parameterised by the Talker for expressive output.

---

## 4. Cross-Cutting Concerns

### 4.1 Conversation History & Compaction

The full transcript of the session is maintained as a append-only log. As the session grows:

- The Reasoner periodically calls `compact_history()`, summarising older segments into a compressed narrative stored in the belief store.
- The Talker's context uses only the recent uncompacted window plus the belief store summary.
- The Reasoner's context uses the full log for deep analysis cycles, switching to compacted history once the log exceeds a manageable size.

### 4.2 Latency Budget

| Path | Target Latency |
| --- | --- |
| Talker: utterance detected → speech starts | < 500ms |
| Talker: with `wait_for_reasoner()` | < Reasoner cycle time + 200ms |
| Reasoner: full cycle time | < 15–20s |
| Avatar reactive command | < 200ms from Talker output |

### 4.3 Prompt & Schema Versioning

All prompt templates for the Talker and Reasoner, the belief store schema, and the avatar command schema should be version-controlled. Changes to any shared schema (especially the belief store) require coordinated updates to both agents' prompts.

### 4.4 Session State & Recovery

- The belief store and compacted history should be persisted to durable storage continuously, so a session can resume after a crash or model restart without full context loss.
- On startup, the system should reload the last known belief store and resume compacted history as its initial context.

### 4.5 Process Model & Parallelism

- The implementation should use multiprocessing or separate worker processes where it materially improves latency, throughput, or fault isolation.
- Likely candidates include streaming STT workers, audio processing, TTS streaming, Reasoner execution, and any CPU-heavy summarisation or compaction tasks.
- The default assumption should not be that all subsystems run in a single Node.js process; process boundaries are acceptable and desirable when they reduce contention on the real-time Talker path.
- Inter-process interfaces should still use the same shared TypeScript contracts to avoid schema drift across subsystem boundaries.

---

## 5. Interfaces Summary

| Interface | From | To | Protocol / Format |
| --- | --- | --- | --- |
| Audio streams | VR World | Input Pipeline | To be defined |
| World state feed | VR World | Input Pipeline | To be defined |
| Event Bus messages | Input Pipeline | Talker, Reasoner | To be defined |
| Belief store read/write | Talker (read), Reasoner (write) | Shared Belief Store | Structured JSON |
| Talker tool calls | Talker | TTS, Avatar Controller, Belief Store, Reasoner | LLM tool call schema |
| Reasoner tool calls | Reasoner | Belief Store, Avatar Controller, History Store | LLM tool call schema |
| Avatar command API | Talker, Reasoner | Avatar Controller | Structured JSON (see Section 3.6) |
| TTS input | Talker | TTS Engine | Streaming text |
| Audio output | TTS Engine | VR spatial audio | To be defined |

---

## 6. Open Questions

Items deferred for future design sessions:

- [x] ~~Belief store full schema definition~~ — implemented in `packages/shared-contracts`
- [ ] STT provider and latency profile — currently using Deepgram Nova-3 (server-side batch); streaming STT not yet wired
- [ ] Talker and Reasoner model selection — currently configurable via env vars
- [x] ~~Event Bus technology choice~~ — in-process EventEmitter-based bus in `packages/event-bus`
- [ ] Exact token thresholds triggering history compaction
- [ ] Avatar command vocabulary finalisation (with Avatar Controller team)
- [x] ~~TTS provider and streaming interface~~ — Deepgram Aura WebSocket streaming in `packages/tts-client`
- [x] ~~Session persistence storage technology~~ — Valkey (Redis-compatible) via `packages/shared-belief-store`
- [ ] Multi-session memory (should the AI remember participants across separate sessions?)
- [ ] Moderator override interface (ability for a human operator to inject directives)

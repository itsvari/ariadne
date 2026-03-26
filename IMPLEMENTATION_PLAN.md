# Project Ariadne — Implementation Plan

> Created: March 2026
> Status: Phase 1–5 complete.

---

## Monorepo Structure

```
ariadne/
├── apps/
│   ├── web/          # Next.js control panel
│   └── server/       # Node.js orchestration server
├── packages/
│   ├── shared-contracts/    # TypeScript types, Zod schemas
│   ├── chat-providers/      # OpenRouter, Cerebras chat providers
│   ├── talker/              # Talker model (System 1)
│   ├── thinker/             # Thinker model (System 2)
│   ├── shared-belief-store/ # Valkey-backed belief store
│   ├── event-bus/           # Event routing between models
│   └── tts-client/          # Deepgram TTS integration
├── turbo.json
├── package.json              # Root with Turborepo workspace config
└── .env                     # Shared env vars
```

---

## Phase 1: Monorepo Setup ✅

### 1.1 Set up Turborepo
- [x] Create root `package.json` with Turborepo workspace config
- [x] Create `turbo.json` configuration
- [x] Create `tsconfig.json` base configuration
- [x] Move `packages/minimal-demo/` → `apps/web/`
- [x] Update internal package.json references

### 1.2 Create shared-contracts package
- [x] Create `packages/shared-contracts/package.json`
- [x] Create `packages/shared-contracts/src/index.ts` — exports all types
- [x] Core schemas:
  - `InterventionMode`, `SessionConfig`, `ChatMessage`
  - `TalkerRequest`, `TalkerResponse`, `TTSRequest`, `TTSProvider`
  - `WsMessage`, `TelemetryEvent`
- [x] Thinker schemas:
  - `BeliefStore` — participants, discussion_state, facilitation_plan, directive_queue, conversation_summary
  - `Participant` — id, speakingFrequency, stance, emotionalTone, engagementLevel
  - `DiscussionState` — currentTopic, phase, openQuestions
  - `Directive` — id, instruction, priority, createdAt
  - `WorldState` — players, location, activities
- [x] Tool call schemas:
  - Talker tools: `speak`, `avatar_command`, `trigger_thinker`, `wait_for_thinker`, `read_belief_store`, `dequeue_directive`
  - Thinker tools: `write_belief_store`, `enqueue_directive`, `read_world_state`, `compact_history`, `avatar_command`

### 1.3 Create chat-providers package
- [x] Create `packages/chat-providers/package.json`
- [x] Create `packages/chat-providers/src/index.ts` — exports providers
- [x] Implement `CerebrasChatProvider`
- [x] Create `OpenRouterChatProvider`:
  - Uses OpenAI-compatible API with custom base URL
  - Implements `ChatProvider` interface
  - Model configurable via `OPENROUTER_MODEL` env var

---

## Phase 2: Core Services ✅

### 2.1 Create shared-belief-store package
- [x] Create `packages/shared-belief-store/package.json`
- [x] Add `iovalkey` dependency
- [x] Implement Valkey-backed store with key prefixes: `belief:`, `directives:`, `history:`, `world:`
- [x] Methods: `readBeliefStore`, `writeBeliefStore`, `enqueueDirective`, `dequeueDirective`, `getDirectives`, `getFulfilledDirectives`, `appendHistory`, `getHistory`, `compactHistory`, `setWorldState`, `getWorldState`, `healthCheck`

### 2.2 Create event-bus package
- [x] Create `packages/event-bus/package.json`
- [x] Create `src/index.ts`:
  - Event types: `UtteranceFinal`, `UtteranceChunk`, `WorldStateUpdate`, `ReasonerComplete`, `TalkerWaitFlag`, `AvatarCommand`
  - `EventBus` class with `subscribe`, `publish`, `requestResponse`
  - In-memory implementation (can swap for Valkey pub/sub later)

### 2.3 Create talker package
- [x] Create `packages/talker/package.json`
- [x] Create `src/index.ts`:
  - System prompts per intervention mode (`control`, `light`, `heavy`)
  - `runTalkerTurn()` function
  - Tool call implementations
  - Telemetry emission

### 2.4 Create thinker package
- [x] Create `packages/thinker/package.json`
- [x] Create `src/index.ts`:
  - Strategic reasoning system prompt
  - `runThinkerTurn()` function
  - Tool call implementations
  - Periodic scheduler with configurable interval

### 2.5 Create tts-client package
- [x] Create `packages/tts-client/package.json`
- [x] Implement `DeepgramTTSProvider` using Deepgram Aura WebSocket streaming API
- [x] Export `synthesizeSpeech` helper

---

## Phase 3: Orchestration Server ✅

### 3.1 Create apps/server
- [x] Create `apps/server/package.json`
- [x] Dependencies: express, cors, ws, @deepgram/sdk, all packages
- [x] Create `src/index.ts`:
  - Express + HTTP server setup
  - Valkey health check on startup
  - OpenRouter + optional Cerebras provider initialisation
  - Deepgram TTS provider initialisation
  - Deepgram STT client initialisation
- [x] Create `src/orchestrator.ts`:
  - Session lifecycle management
  - Periodic Thinker scheduling
  - Talker–Thinker event routing
  - Conversation history management
- [x] REST API endpoints:
  - `GET /health`
  - `POST /session/start`
  - `POST /session/stop`
  - `GET /session/status`
  - `POST /utterance`
  - `POST /utterance/audio` — Deepgram STT
  - `POST /thinker/trigger`
  - `POST /world-state`
  - `GET /belief-store`
  - `GET /directives`
- [x] WebSocket endpoint at `/events?sessionId=<id>`

---

## Phase 4: Control Panel GUI (apps/web) ✅

### 4.1 Base setup ✅
- [x] Next.js 16 app refactored from minimal-demo
- [x] Deepgram STT integration (browser-side, via `NEXT_PUBLIC_DEEPGRAM_API_KEY`)
- [x] TTS audio playback over WebSocket (`tts.audio.chunk` events)
- [x] WebSocket connection for real-time events
- [x] Message history display

### 4.2 Control panel features
- [x] Session status indicators (talker/thinker status, last Thinker run timestamp)
- [x] Belief store visualisation (participants, discussion phase, facilitation plan)
- [x] Directive queue display (pending / fulfilled)
- [x] Control buttons: Start/Stop, manual Thinker trigger, intervention mode selector, Thinker interval slider
- [x] Enhanced system events log

---

## Phase 5: Environment & Testing ✅

### 5.1 Environment configuration
- [x] `.env.example` with all required variables

### 5.2 Integration testing
- [x] Valkey connection verified
- [x] OpenRouter API call tested
- [x] Talker turn execution tested
- [x] Thinker turn execution tested
- [x] Belief store read/write tested
- [x] Periodic Thinker scheduling tested
- [x] Talker–Thinker communication via belief store tested

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | **Yes** (server) | OpenRouter API key. Powers the Talker (and Thinker if Cerebras is not configured). |
| `OPENROUTER_MODEL` | No | Override the default OpenRouter model (e.g. `google/gemini-2.0-flash-001`). |
| `OPENROUTER_BASE_URL` | No | Override the OpenRouter base URL (default: `https://openrouter.ai/api/v1`). |
| `CEREBRAS_API_KEY` | No | Cerebras API key. When set, the Thinker uses Cerebras instead of OpenRouter. |
| `DEEPGRAM_API_KEY` | **Yes** (server) | Powers both STT (`/utterance/audio`) and TTS synthesis over WebSocket. |
| `VALKEY_URL` | No | Valkey connection URL (default: `valkey://localhost:6379`). |
| `NEXT_PUBLIC_SERVER_URL` | No | Server base URL for the web control panel (default: `http://localhost:8081`). |
| `PORT` | No | HTTP port for the server (default: `8081`). |

---

## Dependencies

### Runtime
- `iovalkey` — Valkey client (`shared-belief-store`)
- `openai` — OpenRouter & Cerebras use OpenAI-compatible API (`chat-providers`)
- `@deepgram/sdk` — STT transcription (`apps/server`) and TTS streaming (`tts-client`)
- `ws` — WebSocket server (`apps/server`) and WebSocket client in Node.js (`tts-client`)
- `express`, `cors` — HTTP server (`apps/server`)
- `zod` — Runtime schema validation (`shared-contracts`)

### Development
- `turbo` — Monorepo build orchestration
- `typescript` — Type checking
- `vitest` — Unit testing
- `tsx` — TypeScript execution for dev and prod server scripts

---

## Notes

- All packages use TypeScript with `@ariadne/` internal package prefix.
- The architecture document refers to System 2 as "Reasoner"; the codebase uses "Thinker" throughout.
- The belief store schema is versioned in `shared-contracts` — coordinate updates across Talker and Thinker prompts.
- The Thinker's periodic interval is configurable per session via `thinkerIntervalSec` in `SessionConfig`.

# Project Ariadne - Implementation Plan

> Created: March 2026
> Status: Ready for execution

---

## Monorepo Structure

```
ariadne/
├── apps/
│   ├── web/          # Next.js control panel (refactored from minimal-demo)
│   └── server/      # Node.js orchestration server
├── packages/
│   ├── shared-contracts/    # TypeScript types, Zod schemas
│   ├── chat-providers/      # OpenRouter, Cerebras chat providers
│   ├── talker/              # Talker model (System 1)
│   ├── thinker/             # Thinker model (System 2)
│   ├── shared-belief-store/ # Redis-backed belief store
│   ├── event-bus/           # Event routing between models
│   └── tts-client/          # TTS integration
├── turbo.json
├── package.json              # Root with turborepo setup
└── .env                     # Shared env vars
```

---

## Phase 1: Monorepo Setup

### 1.1 Set up Turborepo
- [ ] Create root `package.json` with turborepo workspace config
- [ ] Create `turbo.json` configuration
- [ ] Create `tsconfig.json` base configuration
- [ ] Move `packages/minimal-demo/` → `apps/web/`
- [ ] Update internal package.json references

### 1.2 Create shared-contracts package
- [ ] Create `packages/shared-contracts/package.json`
- [ ] Create `packages/shared-contracts/src/index.ts` - exports all types
- [ ] Move/refactor existing schemas from `contracts/ai.ts`:
  - `InterventionMode`, `SessionConfig`, `ChatMessage`
  - `TalkerRequest`, `TalkerResponse`, `TTSRequest`
  - `WsMessage`, `TelemetryEvent`
- [ ] Add Thinker schemas:
  - `BeliefStore` - participants, discussion_state, facilitation_plan, directive_queue, conversation_summary
  - `Participant` - id, speakingFrequency, stance, emotionalTone, engagementLevel
  - `DiscussionState` - currentTopic, phase, openQuestions
  - `Directive` - id, instruction, priority, createdAt
  - `WorldState` - players, location, activities
- [ ] Add tool call schemas:
  - Talker tools: `speak`, `avatar_command`, `trigger_reasoner`, `wait_for_reasoner`, `read_belief_store`, `dequeue_directive`
  - Thinker tools: `write_belief_store`, `enqueue_directive`, `read_world_state`, `compact_history`, `avatar_command`

### 1.3 Create chat-providers package
- [ ] Create `packages/chat-providers/package.json`
- [ ] Create `packages/chat-providers/src/index.ts` - exports providers
- [ ] Move/refactor `CerebrasChatProvider` from existing code
- [ ] Create `OpenRouterChatProvider`:
  - Use model string: `openrouter/hunter-alpha`
  - Implement `ChatProvider` interface
  - Use OpenAI-compatible API with custom base URL

---

## Phase 2: Core Services

### 2.1 Create shared-belief-store package
- [ ] Create `packages/shared-belief-store/package.json`
- [ ] Add `ioredis` dependency
- [ ] Create `src/index.ts`:
  - Connect to Redis (use `REDIS_URL` env var, default `localhost:6379`)
  - Define key prefixes: `belief:`, `directives:`, `history:`, `world:`
  - Implement methods:
    - `readBeliefStore(sessionId): Promise<BeliefStore>`
    - `writeBeliefStore(sessionId, store): Promise<void>`
    - `enqueueDirective(sessionId, directive): Promise<void>`
    - `dequeueDirective(sessionId): Promise<Directive | null>`
    - `getDirectives(sessionId): Promise<Directive[]>`
    - `appendHistory(sessionId, utterance): Promise<void>`
    - `getHistory(sessionId, limit?): Promise<Utterance[]>`
    - `compactHistory(sessionId, summary): Promise<void>`
    - `setWorldState(sessionId, state): Promise<void>`
    - `getWorldState(sessionId): Promise<WorldState | null>`
  - Add connection health check

### 2.2 Create event-bus package
- [ ] Create `packages/event-bus/package.json`
- [ ] Create `src/index.ts`:
  - Define event types: `UtteranceFinal`, `UtteranceChunk`, `WorldStateUpdate`, `ReasonerComplete`, `TalkerWaitFlag`, `AvatarCommand`
  - Create `EventBus` class with:
    - `subscribe(eventType, handler)`
    - `publish(event)`
    - `requestResponse(eventType, timeout)`
  - Use in-memory implementation for now (can swap for Redis pub/sub later)

### 2.3 Create talker package
- [ ] Create `packages/talker/package.json`
- [ ] Create `src/index.ts`:
  - Import tool definitions from shared-contracts
  - Create system prompts per intervention mode (control, light, heavy)
  - Implement `runTalkerTurn()` function:
    - Accept: provider, request (messages, beliefSnapshot, directives, worldState, sessionConfig)
    - Return: ChatCompletionResult
  - Tool implementations:
    - `speak` - emit text to TTS
    - `avatar_command` - send to avatar controller
    - `trigger_reasoner` - publish Reasoner trigger event
    - `wait_for_reasoner` - block until Reasoner completes
    - `read_belief_store` - fetch from belief store
    - `dequeue_directive` - pop from directive queue
  - Add telemetry emission

### 2.4 Create thinker package
- [ ] Create `packages/thinker/package.json`
- [ ] Create `src/index.ts`:
  - Define system prompt for strategic reasoning
  - Implement `runThinkerTurn()` function:
    - Accept: provider, sessionId, fullHistory, worldState, currentBeliefStore
    - Return: updatedBeliefStore, directives
  - Tool implementations:
    - `write_belief_store` - update belief store
    - `enqueue_directive` - push to directive queue
    - `read_world_state` - fetch current world state
    - `compact_history` - summarize old conversation
    - `avatar_command` - planned avatar behavior
  - Create scheduler:
    - Periodic invocation (default 60s interval, configurable)
    - On-demand triggers from Talker
  - Add telemetry emission

### 2.5 Create tts-client package (optional - may keep in web app)
- [ ] Create `packages/tts-client/package.json`
- [ ] Move/refactor TTS provider logic
- [ ] Keep simple for now

---

## Phase 3: Orchestration Server

### 3.1 Create apps/server
- [ ] Create `apps/server/package.json`
- [ ] Add dependencies: express, ws, all packages
- [ ] Create `src/index.ts`:
  - Express server setup
  - Initialize Redis connection
  - Initialize chat providers (OpenRouter, Cerebras)
  - Create orchestrator instance
- [ ] Create `src/orchestrator.ts`:
  - Manage session lifecycle
  - Handle periodic Thinker scheduling
  - Route events between Talker and Thinker
  - Maintain conversation history
- [ ] Create API endpoints:
  - `POST /session/start` - initialize session
  - `POST /session/stop` - terminate session
  - `POST /utterance` - process user utterance
  - `POST /thinker/trigger` - manually trigger Thinker
  - `GET /session/status` - get current state
  - `GET /belief-store` - get current beliefs
  - `GET /directives` - get pending directives
- [ ] Create WebSocket endpoint for real-time events

### 3.2 Wire up apps/server
- [ ] Initialize all packages on startup
- [ ] Verify Redis connectivity (health check on boot)
- [ ] Test OpenRouter API key presence

---

## Phase 4: Control Panel GUI (apps/web)

### 4.1 Refactor apps/web from minimal-demo
- [ ] Update package.json workspace references
- [ ] Keep existing functionality:
  - STT integration (Deepgram)
  - TTS playback
  - WebSocket connection for events
  - Message history display
- [ ] Refactor to use packages instead of local code:
  - Import Talker from `@ariadne/talker`
  - Import belief store client from `@ariadne/shared-belief-store`

### 4.2 Add control panel features
- [ ] Session status indicators:
  - Talker status (idle/active/waiting)
  - Thinker status (idle/running/scheduled)
  - Last Thinker run timestamp
- [ ] Belief store visualization:
  - Current participants
  - Discussion phase/topic
  - Facilitation plan
- [ ] Directive queue display:
  - List pending directives
  - Show fulfilled directives
- [ ] Control buttons:
  - Start/Stop session
  - Manual "Trigger Thinker"
  - Intervention mode selector (control/light/heavy)
  - Periodic Thinker interval slider (30s/60s/120s)
- [ ] System events log (enhance existing)

---

## Phase 5: Environment & Testing

### 5.1 Environment configuration
- [ ] Update `.env.example` with:
  ```
  OPENROUTER_API_KEY=your_openrouter_api_key
  REDIS_URL=redis://localhost:6379
  CEREBRAS_API_KEY=your_cerebras_api_key
  INWORLD_API_KEY=your_inworld_api_key
  DEEPGRAM_API_KEY=your_deepgram_api_key
  ```
- [ ] Create `.env` with placeholder values for development

### 5.2 Testing
- [ ] Verify Redis connection: `redis-cli ping`
- [ ] Test OpenRouter API call
- [ ] Test Talker turn execution
- [ ] Test Thinker turn execution
- [ ] Test belief store read/write
- [ ] Test periodic Thinker scheduling
- [ ] Test Talker-Thinker communication via belief store

---

## File Summary

### New Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Root workspace config |
| `turbo.json` | Turborepo configuration |
| `tsconfig.json` | Base TypeScript config |
| `packages/shared-contracts/package.json` | Contracts package |
| `packages/shared-contracts/src/index.ts` | All type definitions |
| `packages/chat-providers/package.json` | Chat providers package |
| `packages/chat-providers/src/index.ts` | Provider exports |
| `packages/chat-providers/src/openrouter.ts` | OpenRouter provider |
| `packages/shared-belief-store/package.json` | Belief store package |
| `packages/shared-belief-store/src/index.ts` | Redis belief store |
| `packages/event-bus/package.json` | Event bus package |
| `packages/event-bus/src/index.ts` | Event routing |
| `packages/talker/package.json` | Talker package |
| `packages/talker/src/index.ts` | Talker implementation |
| `packages/thinker/package.json` | Thinker package |
| `packages/thinker/src/index.ts` | Thinker implementation |
| `apps/server/package.json` | Server app |
| `apps/server/src/index.ts` | Express server |
| `apps/server/src/orchestrator.ts` | Session orchestrator |
| `apps/server/src/routes/*.ts` | API routes |

### Files to Refactor/Move

| From | To |
|------|-----|
| `packages/minimal-demo/` | `apps/web/` |
| `packages/minimal-demo/src/server/contracts/ai.ts` | `packages/shared-contracts/src/` |
| `packages/minimal-demo/src/server/providers/chat/cerebras.ts` | `packages/chat-providers/src/` |
| `packages/minimal-demo/src/server/usecases/talker.ts` | `packages/talker/src/` |

### Files to Delete

| File | Reason |
|------|--------|
| `packages/minimal-demo/` | Moved to apps/web |

---

## Dependencies

### Runtime
- `ioredis` - Redis client (shared-belief-store)
- `openai` - OpenRouter uses OpenAI-compatible API (chat-providers)
- `express` - HTTP server (apps/server)
- `ws` - WebSocket server (apps/server)

### Development
- `turbo` - Build orchestration
- `typescript` - Already in use
- `vitest` - Already in use

---

## Notes

- All packages should use TypeScript
- Use `@ariadne/` prefix for internal packages
- Follow existing code style conventions
- Keep tool definitions in shared-contracts for version consistency
- Belief store schema may evolve - version it
- Thinker interval should be configurable per session

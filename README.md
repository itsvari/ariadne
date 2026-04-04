# Project Ariadne

Project Ariadne is an LLM-powered, embodied discussion facilitator for 3D virtual environments. It operates as an AI participant inside a multiplayer VR world, perceiving conversation through live audio, interpreting world state, and participating through a TTS-synthesised voice and avatar control.

Originally built for [CS4240 Interaction Design for Virtual and Augmented Reality](https://nusmods.com/courses/CS4240/interaction-design-for-virtual-and-augmented-reality) at the National University of Singapore (NUS).

## Architecture

Ariadne uses a **Talker–Thinker** dual-agent pattern:

- The **Talker** (System 1) is a fast, small-to-medium LLM that reacts to conversation events in near real-time.
- The **Thinker** (System 2) is a slower, more capable LLM that runs periodically to update a shared belief store with strategic facilitation guidance.

See [`project_ariadne_architecture.md`](./project_ariadne_architecture.md) for the full system design.

## Repository Structure

```
ariadne/
├── apps/
│   ├── web/          # Next.js control panel
│   └── server/       # Node.js orchestration server
└── packages/
    ├── shared-contracts/    # TypeScript types & Zod schemas
    ├── chat-providers/      # OpenRouter & Cerebras chat providers
    ├── talker/              # Talker agent (System 1)
    ├── thinker/             # Thinker agent (System 2)
    ├── shared-belief-store/ # Valkey-backed belief store
    ├── event-bus/           # In-process event routing
    └── tts-client/          # Deepgram TTS integration
```

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **npm** >= 10
- **Valkey** (or Redis-compatible) on `localhost:6379`

### Installation

```bash
# Install all workspace dependencies
npm install
```

### Environment

Copy `.env.example` to `.env` at the repo root and fill in your API keys:

```bash
cp .env.example .env
```

The server also reads a `.env` inside `apps/server/` — see [`apps/server/README.md`](./apps/server/README.md) for the full variable reference.

### Running in Development

```bash
# Start both the server and web control panel in parallel
npm run dev

# Or individually (using Turborepo filters internally):
npm run dev:server
npm run dev:web
```

- Server: `http://localhost:8081`
- Web control panel: `http://localhost:3000`

### Testing

```bash
npm test
```

The project includes **179 unit tests** across all 7 packages (~90% line coverage):

| Package | Tests | Line Coverage |
|---|---|---|
| `shared-contracts` | 44 | 100% |
| `chat-providers` | 16 | 100% |
| `event-bus` | 9 | 100% |
| `talker` | 20 | 90% |
| `thinker` | 30 | 84% |
| `tts-client` | 35 | 95% |
| `shared-belief-store` | 25 | 84% |

## Documentation

| Document | Description |
|---|---|
| [`project_ariadne_architecture.md`](./project_ariadne_architecture.md) | Full system architecture and design decisions |
| [`apps/server/README.md`](./apps/server/README.md) | Server REST API & WebSocket reference |

## Unity Integration Notes

- The current Unity multiplayer template is distributed-authority (not dedicated server-authoritative).
- Ariadne still runs as a central orchestration service; Quest clients connect to the same Ariadne session over WebSocket.
- In distributed-authority mode, appoint exactly one client (typically the current session owner) to publish world-state snapshots to avoid duplicate/conflicting updates.
- Microphone audio can be streamed over WebSocket using `client.audio.chunk` and `client.audio.commit`; the server emits `stt.transcript` after transcription and then routes the text through the normal utterance pipeline.
- Clients can pass startup policy in `client.hello.payload.sessionConfig` (for example intervention mode and thinker interval).
- Session teardown can be done explicitly with `POST /session/stop`.
- LAN auto-discovery is available for ad-hoc local hosting via UDP discovery (`ariadne.discover.request` / `ariadne.discover.response`).

## Protocol Highlights (Latest)

- `client.hello` accepts optional partial session config (`interventionMode`, `groupSize`, `taskId`, `phase`, `thinkerIntervalSec`). `interventionMode` currently supports `control` and `light`.
- `avatar.command` supports command priority (`reactive` or `planned`) and includes expression commands.
- Streaming STT over WebSocket now includes a dedicated broadcast event: `stt.transcript`.
- Session status and recent event history are available via `GET /session/status?sessionId=<id>`.
- Talker context window is configurable with `TALKER_CONTEXT_TURNS` (default: 10 turns).
- Thinker runs on full session history and updates belief store and directives with the latest world state context.

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | **Yes** (server) | OpenRouter API key. Powers the Talker (and Thinker if Cerebras is not configured). |
| `OPENROUTER_MODEL` | No | Override the default OpenRouter model (e.g. `google/gemini-2.0-flash-001`). |
| `OPENROUTER_BASE_URL` | No | Override the OpenRouter base URL (default: `https://openrouter.ai/api/v1`). |
| `CEREBRAS_API_KEY` | No | Cerebras API key. When set, the Thinker uses Cerebras instead of OpenRouter. |
| `DEEPGRAM_API_KEY` | **Yes** (server) | API key for server-side TTS synthesis and STT transcription. |
| `NEXT_PUBLIC_DEEPGRAM_API_KEY` | **Yes** (web) | API key for browser-side STT transcription in the control panel. |
| `VALKEY_URL` | No | Valkey connection URL (default: `valkey://localhost:6379`). |
| `NEXT_PUBLIC_SERVER_URL` | No | Server base URL for the web control panel (default: `http://localhost:8081`). |
| `PORT` | No | HTTP port for the server (default: `8081`). |

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
- `vitest` — Unit testing (179 tests across 7 packages)
- `@vitest/coverage-v8` — Code coverage reporting
- `tsx` — TypeScript execution for dev and prod server scripts

## Notes

- All packages use TypeScript with `@ariadne/` internal package prefix.
- The architecture document refers to System 2 as "Reasoner"; the codebase uses "Thinker" throughout.
- The belief store schema is versioned in `shared-contracts` — coordinate updates across Talker and Thinker prompts.
- The Thinker's periodic interval is configurable per session via `thinkerIntervalSec` in `SessionConfig`.

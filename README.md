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

## Documentation

| Document | Description |
|---|---|
| [`project_ariadne_architecture.md`](./project_ariadne_architecture.md) | Full system architecture and design decisions |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Phase-by-phase build plan with completion status |
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

- `client.hello` accepts optional partial session config (`interventionMode`, `groupSize`, `taskId`, `phase`, `thinkerIntervalSec`).
- `avatar.command` supports command priority (`reactive` or `planned`) and includes expression commands.
- Streaming STT over WebSocket now includes a dedicated broadcast event: `stt.transcript`.
- Session status and recent event history are available via `GET /session/status?sessionId=<id>`.

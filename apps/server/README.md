# Ariadne Server

The central orchestration server for the Ariadne system. It manages collaborative sessions, routes user utterances through the Talker (conversational AI) and Thinker (reasoning AI) pipelines, provides speech-to-text and text-to-speech via Deepgram, and streams real-time events to connected clients over WebSocket.

## Prerequisites

- **Node.js** >= 18
- **npm** >= 10 (the monorepo uses npm workspaces)
- **Valkey** (or Redis-compatible server) running locally on port `6379` — used by the shared belief store

Install all dependencies from the **monorepo root**:

```bash
npm install
```

## Environment Variables

Create a `.env` file inside `apps/server/`. The dev and start scripts load it automatically via `--env-file=.env`.

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | **Yes** | API key for OpenRouter. Powers the Thinker model in this server build. |
| `OPENROUTER_THINKER_MODEL` | No | Override the Thinker model (default: `qwen/qwen3.6-plus:free`). |
| `OPENROUTER_BASE_URL` | No | Override OpenRouter API base URL (default: `https://openrouter.ai/api/v1`). |
| `CEREBRAS_API_KEY` | **Yes** | API key for Cerebras. Powers the Talker model in this server build. |
| `CEREBRAS_TALKER_MODEL` | No | Override the Talker model (default: `gpt-oss-120b`). |
| `DEEPGRAM_API_KEY` | **Yes** | API key for Deepgram. Powers speech-to-text (`/utterance/audio`) and text-to-speech streaming over WebSocket. |
| `TALKER_CONTEXT_TURNS` | No | Number of recent conversational turns included for the Talker (default: `10`). Internally this maps to roughly `2 x turns` utterances. |
| `LOG_SYSTEM_EVENTS` | No | Enable structured event logging to console (default: `true`). |
| `LOG_SYSTEM_EVENTS_TO_FILE` | No | Enable NDJSON event logging to file (default: `true`). |
| `LOG_SYSTEM_EVENTS_FILE` | No | Relative or absolute path for NDJSON event log file (default: `logs/system-events.ndjson`). |
| `PORT` | No | HTTP port. Defaults to `8081`. |
| `DISCOVERY_ENABLED` | No | Enable UDP LAN discovery responder. Defaults to `true`. |
| `DISCOVERY_PORT` | No | UDP port for LAN discovery request/response. Defaults to `9876`. |

Example `.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_THINKER_MODEL=qwen/qwen3.6-plus:free
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
CEREBRAS_API_KEY=csk-...
CEREBRAS_TALKER_MODEL=gpt-oss-120b
DEEPGRAM_API_KEY=af9ae...
TALKER_CONTEXT_TURNS=10
LOG_SYSTEM_EVENTS=true
LOG_SYSTEM_EVENTS_TO_FILE=true
LOG_SYSTEM_EVENTS_FILE=logs/system-events.ndjson
DISCOVERY_ENABLED=true
DISCOVERY_PORT=9876
```

## Running the Server

From the **monorepo root**:

```bash
# Development (hot-reload via tsx watch)
npm run dev:server

# Or directly from apps/server:
cd apps/server
npm run dev
```

For production:

```bash
cd apps/server
npm run build    # compiles TypeScript
npm run start    # runs with tsx + .env
```

On startup the server will:

1. Verify `OPENROUTER_API_KEY` is present
2. Health-check the Valkey/Redis connection
3. Initialize the Talker (Cerebras), Thinker (OpenRouter), TTS, and Deepgram providers
4. Start UDP LAN discovery responder (unless disabled)
5. Listen on `http://localhost:8081` (or the configured `PORT`)

## Runtime Behavior Notes

- Talker receives recent conversational context using `TALKER_CONTEXT_TURNS` (default 10 turns).
- Thinker reads full session history plus latest belief store and world state.
- Talker treats thinker directives as relevance-aware guidance (not unconditional commands).
- If thinker finishes with directives while session is idle, server may trigger a talker follow-up.
- If a newer user utterance arrives after thinker started, stale auto-follow-up is skipped.
- Talker output is expected to be plain spoken text; server also strips markdown-like syntax before TTS as a safety fallback.

## LAN Discovery (UDP)

To support ad-hoc local hosting across multiple headsets, the server exposes a UDP discovery responder.

- Default port: `9876` (configurable via `DISCOVERY_PORT`)
- Enable/disable: `DISCOVERY_ENABLED=true|false`

Client broadcast request:

```json
{
  "type": "ariadne.discover.request",
  "protocolVersion": "v1"
}
```

Server response:

```json
{
  "type": "ariadne.discover.response",
  "protocolVersion": "v1",
  "transport": "ws",
  "wsPort": 8081,
  "wsPath": "/events",
  "serverName": "host-machine-name",
  "timestamp": "2026-04-01T12:00:00.000Z"
}
```

Clients can use the response sender IP plus `wsPort`/`wsPath` to construct:

`ws://<discovered-ip>:<wsPort><wsPath>?sessionId=<session-id>`

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Express + HTTP                     │
│  REST endpoints for sessions, utterances, state      │
├─────────────────────────────────────────────────────┤
│                AriadneOrchestrator                    │
│  ┌───────────┐  ┌───────────┐  ┌─────────────────┐  │
│  │  Talker    │  │  Thinker  │  │  Belief Store   │  │
│  │ (OpenRouter│  │ (Cerebras │  │  (Valkey/Redis) │  │
│  │  / Gemini) │  │  or OR)   │  │                 │  │
│  └───────────┘  └───────────┘  └─────────────────┘  │
│  ┌──────────────────────────────┐                    │
│  │  Deepgram (STT + TTS)         │                    │
│  └──────────────────────────────┘                    │
├─────────────────────────────────────────────────────┤
│              WebSocket (/events)                      │
│  Real-time event stream to connected clients          │
└─────────────────────────────────────────────────────┘
```

## REST API Reference

All POST endpoints accept and return `application/json`. Errors are returned as `{ "error": "message" }`.

### Health

#### `GET /health`

Returns the server's health status and which providers are configured.

**Response:**

```json
{
  "ok": true,
  "valkey": true,
  "openrouterConfigured": true,
  "cerebrasConfigured": true,
  "deepgramTTSConfigured": true
}
```

---

### Sessions

#### `POST /session/start`

Creates a new session with a server-generated UUID.

If a session with the same `sessionId` already has data in Valkey, the server now archives that previous snapshot and starts with a fresh belief store/history/directive state.

**Request body:**

```json
{
  "sessionConfig": {
    "interventionMode": "control",
    "groupSize": 3,
    "taskId": "task-abc",
    "phase": "brainstorming",
    "thinkerIntervalSec": 60
  }
}
```

All fields inside `sessionConfig` are optional. `interventionMode` can be `"control"` or `"light"` (defaults to `"control"`). `thinkerIntervalSec` controls how often the Thinker runs automatically (defaults to `60`, range 15–600).

**Response:** `SessionStatus` object (see below).

#### `POST /session/stop`

Stops a running session.

**Request body:**

```json
{ "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
```

**Response:** `SessionStatus` object, or `404` if the session doesn't exist.

#### `GET /session/status`

Query session status.

- Without `?sessionId=` — returns all sessions: `{ "sessions": [SessionStatus, ...] }`
- With `?sessionId=<id>` — returns one session: `{ "status": SessionStatus, "events": [WsMessage, ...] }`

**`SessionStatus` shape:**

```json
{
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "active": true,
  "talkerStatus": "idle",
  "thinkerStatus": "scheduled",
  "interventionMode": "control",
  "thinkerIntervalSec": 60,
  "lastThinkerRunAt": "2026-03-26T12:00:00.000Z",
  "startedAt": "2026-03-26T11:55:00.000Z",
  "lastActivityAt": "2026-03-26T12:00:00.000Z"
}
```

`talkerStatus`: `"idle"` | `"active"` | `"waiting"` — `thinkerStatus`: `"idle"` | `"running"` | `"scheduled"`

---

### Utterances

#### `POST /utterance`

Submit a text utterance from a user. This appends it to the session history, broadcasts it over WebSocket, and triggers the Talker to generate a response.

**Request body:**

```json
{
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "text": "I think we should try the bridge first.",
  "speakerId": "player-1"
}
```

`speakerId` is optional.

**Response:**

```json
{ "ok": true }
```

#### `POST /utterance/audio`

Submit audio for speech-to-text transcription. The server transcribes via Deepgram, then feeds the transcript into the same pipeline as `/utterance`. Requires `DEEPGRAM_API_KEY` to be configured.

**Request body:**

```json
{
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "speakerId": "player-1",
  "audioBase64": "<base64-encoded linear16 PCM audio>"
}
```

The audio should be **linear16 PCM** encoded. `speakerId` is optional.

**Response (speech detected):**

```json
{ "ok": true, "transcript": "I think we should try the bridge first." }
```

**Response (silence / no speech):**

```json
{ "ok": true, "transcript": "" }
```

---

### Thinker

#### `POST /thinker/trigger`

Manually trigger the Thinker reasoning cycle for a session.

**Request body:**

```json
{
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "reason": "manual"
}
```

`reason` is optional (defaults to `"manual"`).

**Response:**

```json
{ "ok": true }
```

---

### World State

#### `POST /world-state`

Push an updated world state into the session. This is stored in the belief store and broadcast over WebSocket.

**Request body:**

```json
{
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "state": { "objects": [], "positions": {} }
}
```

The `state` value is an arbitrary JSON object representing the current world/environment state.

**Response:**

```json
{ "ok": true }
```

---

### Belief Store & Directives

#### `GET /belief-store?sessionId=<id>`

Returns the full belief store for a session.

#### `GET /directives?sessionId=<id>`

Returns pending and fulfilled directives for a session.

**Response:**

```json
{
  "pending": [],
  "fulfilled": []
}
```

#### `GET /belief-store/archives?sessionId=<id>`

Lists archived snapshots for that session (newest first).

**Response:**

```json
{
  "sessionId": "session-123",
  "archives": [
    {
      "archiveId": "session-123:2026-04-04T11:22:33.444Z:uuid",
      "sessionId": "session-123",
      "archivedAt": "2026-04-04T11:22:33.444Z",
      "utteranceCount": 42,
      "pendingDirectiveCount": 2,
      "fulfilledDirectiveCount": 7
    }
  ]
}
```

#### `GET /belief-store/archive?archiveId=<id>`

Returns a full archived snapshot payload for export or offline analysis.

---

## WebSocket API

Connect to `ws://localhost:8081/events?sessionId=<id>` to receive real-time events for a session.

On connection, the server immediately sends a `session.status` event with the current state.

The socket is bidirectional:

- Server to client: session updates, TTS audio chunks, avatar commands, STT transcripts, telemetry
- Client to server: participant registration (`client.hello`), utterances, world-state updates, thinker triggers, ping, and streamed audio chunks/commit

For distributed-authority Unity sessions, send world-state updates from exactly one appointed authority client (typically the current session owner) to avoid duplicate/conflicting state snapshots.

All messages are JSON with this shape:

```json
{
  "type": "event.type",
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "eventId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "timestamp": "2026-03-26T12:00:00.000Z",
  "payload": {}
}
```

### Event Types

| Type | Payload | Description |
|---|---|---|
| `session.status` | `SessionStatus` | Session state changed (start, stop, talker/thinker status updates) |
| `utterance.final` | `{ id, role, speakerId?, text, timestamp }` | A user utterance was finalized |
| `speak` | `{ text }` | The Talker is speaking (text content) |
| `tts.audio.start` | `{ encoding, sampleRateHz, channels }` | Metadata for the upcoming TTS stream (`linear16`, 24000Hz, mono by default) |
| `tts.audio.chunk` | `{ seq, encoding, sampleRateHz, channels, audioBase64 }` | A chunk of TTS audio (base64-encoded raw PCM linear16 bytes by default) |
| `tts.audio.done` | `{ totalChunks }` | TTS audio stream completed |
| `talker.output` | Talker result object | Full Talker turn output |
| `reasoner.complete` | `{ reason, directiveCount, updatedBeliefStore }` | Thinker finished a reasoning cycle |
| `world_state.update` | World state object | World state was updated |
| `avatar.command` | `{ ..., priority }` | Avatar animation/behavior command (`priority`: `"reactive"` or `"planned"`) |
| `stt.transcript` | `{ speakerId?, text, reason }` | Transcript generated from streamed `client.audio.*` chunks |
| `telemetry` | Telemetry event | Internal telemetry from Talker or Thinker (`model.request`, `model.response`, latency, reasoner follow-up decisions, fallback speech, etc.) |
| `client.hello.ack` | `{ clientId, participantId?, sessionStatus }` | Direct acknowledgement to registering socket |
| `client.pong` | `{ sentAt?, receivedAt }` | Response to `client.ping` |
| `client.joined` | `{ clientId, participantId?, connectedClients }` | A client completed `client.hello` registration |
| `client.left` | `{ clientId, participantId?, connectedClients }` | A registered client disconnected |
| `error` | `{ message }` | An error occurred during processing |

### Client Messages

Quest clients can send JSON messages over the same WebSocket. The server validates each message and replies with `error` for invalid payloads.

#### `client.hello`

Registers a headset client for the session. If `autoStartSession` is omitted or `true`, the session is started automatically when this message arrives.

```json
{
  "type": "client.hello",
  "payload": {
    "clientId": "quest-a",
    "participantId": "player-1",
    "autoStartSession": true,
    "sessionConfig": {
      "interventionMode": "control",
      "groupSize": 3,
      "taskId": "room-2",
      "phase": "discussion",
      "thinkerIntervalSec": 60
    }
  }
}
```

`sessionConfig` is optional and partial; omitted fields use server defaults.

Server responses/events:

- Direct ack to that socket: `client.hello.ack`
- Broadcast to session: `client.joined`

#### `client.utterance.final`

Submits a final transcript turn from a headset participant.

```json
{
  "type": "client.utterance.final",
  "payload": {
    "text": "Can we split up and search both rooms?",
    "speakerId": "player-1"
  }
}
```

This follows the same processing path as `POST /utterance`.

#### `client.world_state`

Pushes a world-state snapshot from a Quest client.

Recommended pattern for distributed authority: only the currently appointed authority client should send this message.

```json
{
  "type": "client.world_state",
  "payload": {
    "state": {
      "players": [
        {
          "id": "player-1",
          "location": "room-a",
          "activity": "speaking",
          "proximity": 0.4
        }
      ],
      "location": "room-a",
      "activities": ["discussion"]
    }
  }
}
```

#### `client.thinker.trigger`

Manually trigger the Thinker from a client.

```json
{
  "type": "client.thinker.trigger",
  "payload": {
    "reason": "player_requested_summary"
  }
}
```

#### `client.ping`

Optional heartbeat. Server replies with `client.pong`.

```json
{
  "type": "client.ping",
  "payload": {
    "sentAt": "2026-04-01T12:00:00.000Z"
  }
}
```

#### `client.audio.chunk`

Streams microphone PCM chunks over the existing WebSocket connection.

```json
{
  "type": "client.audio.chunk",
  "payload": {
    "audioBase64": "<base64 linear16 pcm>",
    "sampleRateHz": 16000,
    "channels": 1,
    "sequence": 0,
    "speakerId": "player-1"
  }
}
```

The server forwards `sampleRateHz` and `channels` to Deepgram transcription, so Unity clients should send accurate values that match the encoded PCM.

#### `client.audio.commit`

Marks the end of one streamed utterance segment (for example after VAD silence). On commit, the server transcribes buffered chunks and routes transcript text through the same pipeline as `client.utterance.final` and `POST /utterance`.

```json
{
  "type": "client.audio.commit",
  "payload": {
    "speakerId": "player-1",
    "reason": "vad_silence"
  }
}
```

### Streaming STT Flow

1. Client sends one or more `client.audio.chunk` messages.
2. Client sends `client.audio.commit`.
3. Server transcribes buffered audio (if Deepgram is configured).
4. Server broadcasts `stt.transcript`.
5. Server feeds transcript into the normal utterance flow, resulting in `utterance.final`, Talker output, and optional TTS/avatar events.

## Troubleshooting

| Problem | Fix |
|---|---|
| `OPENROUTER_API_KEY is required` | Make sure `.env` exists in `apps/server/` with a valid key |
| `Valkey health check failed` | Start Valkey/Redis on port 6379 — e.g. `docker run -p 6379:6379 valkey/valkey:latest` |
| `DEEPGRAM_API_KEY is not configured` | Add `DEEPGRAM_API_KEY` to `.env` — required for both STT and TTS |
| `Streaming audio received, but no transcription provider is configured.` | Configure `DEEPGRAM_API_KEY` so `client.audio.commit` can produce transcripts |
| WebSocket won't connect | Connect to path `/events?sessionId=<id>` — other paths are rejected |
| `Session <id> not found` | For REST-only workflows, call `/session/start` before querying status; WebSocket clients can auto-start via `client.hello` |

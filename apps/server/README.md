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
| `OPENROUTER_API_KEY` | **Yes** | API key for OpenRouter. Powers the Talker (and Thinker if Cerebras is not set). The server will refuse to start without this. |
| `CEREBRAS_API_KEY` | No | API key for Cerebras. When set, the Thinker uses Cerebras instead of OpenRouter. |
| `DEEPGRAM_API_KEY` | **Yes** | API key for Deepgram. Powers speech-to-text (`/utterance/audio`) and text-to-speech streaming over WebSocket. |
| `OPENROUTER_MODEL` | No | Override the default OpenRouter model (e.g. `google/gemini-2.0-flash-001`). |
| `PORT` | No | HTTP port. Defaults to `8081`. |

Example `.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
CEREBRAS_API_KEY=csk-...
DEEPGRAM_API_KEY=af9ae...
OPENROUTER_MODEL=google/gemini-2.0-flash-001
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
3. Initialize the Talker, Thinker, TTS, and Deepgram providers
4. Listen on `http://localhost:8081` (or the configured `PORT`)

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

All fields inside `sessionConfig` are optional. `interventionMode` can be `"control"`, `"light"`, or `"heavy"` (defaults to `"control"`). `thinkerIntervalSec` controls how often the Thinker runs automatically (defaults to `60`, range 15–600).

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

---

## WebSocket API

Connect to `ws://localhost:8081/events?sessionId=<id>` to receive real-time events for a session.

On connection, the server immediately sends a `session.status` event with the current state.

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
| `utterance.final` | `{ utteranceId, speakerId?, text }` | A user utterance was finalized |
| `speak` | `{ text }` | The Talker is speaking (text content) |
| `tts.audio.chunk` | `{ seq, audioBase64 }` | A chunk of TTS audio (base64-encoded) |
| `tts.audio.done` | `{ totalChunks }` | TTS audio stream completed |
| `talker.output` | Talker result object | Full Talker turn output |
| `reasoner.complete` | `{ reason, directiveCount, updatedBeliefStore }` | Thinker finished a reasoning cycle |
| `world_state.update` | World state object | World state was updated |
| `avatar.command` | `{ ..., priority }` | Avatar animation/behavior command (`priority`: `"reactive"` or `"planned"`) |
| `telemetry` | Telemetry event | Internal telemetry from Talker or Thinker |
| `error` | `{ message }` | An error occurred during processing |

## Troubleshooting

| Problem | Fix |
|---|---|
| `OPENROUTER_API_KEY is required` | Make sure `.env` exists in `apps/server/` with a valid key |
| `Valkey health check failed` | Start Valkey/Redis on port 6379 — e.g. `docker run -p 6379:6379 valkey/valkey:latest` |
| `DEEPGRAM_API_KEY is not configured` | Add `DEEPGRAM_API_KEY` to `.env` — required for both STT and TTS |
| WebSocket won't connect | Connect to path `/events?sessionId=<id>` — other paths are rejected |
| `Session <id> not found` | Call `/session/start` first to create a session before sending utterances |

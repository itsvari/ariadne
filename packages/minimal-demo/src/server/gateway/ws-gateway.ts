import { loadEnvConfig } from "@next/env";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { WsMessage, SessionConfig, InterventionMode } from "../contracts/ai";
import { CerebrasChatProvider } from "../providers/chat/cerebras";
import { InworldTTSProvider } from "../providers/tts/inworld";
import { EventRouter } from "./event-router";

// Keep the standalone gateway aligned with Next's env loading behavior.
loadEnvConfig(process.cwd());

export interface GatewayOptions {
  port?: number;
  defaultInterventionMode?: InterventionMode;
}

/**
 * Standalone WebSocket gateway server.
 *
 * Run with: npx tsx src/server/gateway/ws-gateway.ts
 * Or import startGateway() from another entry point.
 */
export function startGateway(opts: GatewayOptions = {}): WebSocketServer {
  const port = 8081;
  const defaultMode = opts.defaultInterventionMode ?? "control";

  const wss = new WebSocketServer({ port });
  console.log(`[ws-gateway] listening on ws://0.0.0.0:${port}`);

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const mode =
      (url.searchParams.get("mode") as InterventionMode) ?? defaultMode;

    const sessionConfig: SessionConfig = {
      interventionMode: mode,
      groupSize: Number(url.searchParams.get("groupSize")) || undefined,
      taskId: url.searchParams.get("taskId") ?? undefined,
    };

    console.log(
      `[ws-gateway] new connection session=${sessionId} mode=${mode}`,
    );

    const send = (msg: WsMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    let chatProvider: CerebrasChatProvider;
    let ttsProvider: InworldTTSProvider;

    try {
      chatProvider = new CerebrasChatProvider();
      ttsProvider = new InworldTTSProvider();
    } catch (err) {
      console.error("[ws-gateway] provider init failed", err);
      ws.close(1011, "Provider initialization failed");
      return;
    }

    const router = new EventRouter({
      chatProvider,
      ttsProvider,
      sessionConfig,
      send,
    });

    ws.on("message", async (data) => {
      try {
        const raw = JSON.parse(data.toString());
        const msg: WsMessage = {
          type: raw.type,
          sessionId: raw.sessionId ?? sessionId,
          eventId: raw.eventId ?? crypto.randomUUID(),
          timestamp: raw.timestamp ?? new Date().toISOString(),
          payload: raw.payload ?? {},
        };

        await router.handleInbound(msg);
      } catch (err) {
        console.error("[ws-gateway] message handling error", err);
        send({
          type: "error",
          sessionId,
          eventId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          payload: {
            error: err instanceof Error ? err.message : "Unknown error",
          },
        });
      }
    });

    ws.on("close", () => {
      console.log(`[ws-gateway] session ${sessionId} disconnected`);
    });
  });

  return wss;
}

// Allow running directly: npx tsx src/server/gateway/ws-gateway.ts
const isDirectRun = typeof require !== "undefined" && require.main === module;

if (isDirectRun) {
  startGateway();
}

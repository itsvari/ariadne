import { NextRequest } from "next/server";
import WebSocket from "ws";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    const apiKey = process.env.NEXT_PUBLIC_INWORLD_API_KEY || process.env.INWORLD_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "No API key" }), { status: 500 });
    }

    const stream = new ReadableStream({
      async start(controller) {
        let isClosed = false;
        
        const closeDown = () => {
          if (!isClosed) {
            isClosed = true;
            try { controller.close(); } catch (e) {}
          }
        };

        const ws = new WebSocket('wss://api.inworld.ai/tts/v1/voice:streamBidirectional', {
          headers: { 'Authorization': apiKey.startsWith('Basic') ? apiKey : `Basic ${apiKey}` }
        });

        const ctxId = crypto.randomUUID();
        const requests = [
          {
              context_id: ctxId,
              create: {
                  voice_id: 'Clive',
                  model_id: 'inworld-tts-1.5-mini', 
                  audio_config: {
                      audio_encoding: 'MP3',
                      sample_rate_hertz: 24000
                  }
              }
          },
          {
              context_id: ctxId,
              send_text: {
                  text: text,
                  flush_context: {}
              }
          },
          {
              context_id: ctxId,
              close_context: {}
          }
        ];

        ws.on('open', () => {
          for (const req of requests) {
            ws.send(JSON.stringify(req));
          }
        });

        ws.on('message', (data: Buffer) => {
          try {
            const response = JSON.parse(data.toString());
            
            if (response.error) {
              console.error("Inworld WS Error:", response.error);
              if (!isClosed) controller.error(new Error(response.error.message));
              ws.close();
              return;
            }

            if (response.result?.audioChunk) {
              const b64 = response.result.audioChunk.audioContent || response.result.audioContent;
              if (b64) {
                const audioBytes = Buffer.from(b64, 'base64');
                if (!isClosed) controller.enqueue(audioBytes);
              }
            }
            
            if (response.result?.contextClosed || response.done) {
              closeDown();
              ws.close();
            }
          } catch (err) {
            // ignore JSON parse errors or other issues
          }
        });

        ws.on('close', () => {
          closeDown();
        });

        ws.on('error', (err) => {
          if (!isClosed) controller.error(err);
          closeDown();
        });
      }
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'audio/mpeg' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to initialize TTS stream" }), { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const talkerClient = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY || 'build-time-dummy-key',
  baseURL: 'https://api.cerebras.ai/v1',
});

export async function POST(request: Request) {
  try {
    const { messages } = await request.json();

    const response = await talkerClient.chat.completions.create({
      model: 'gpt-oss-120b',
      messages: [
        { 
          role: 'system', 
          content: 'You are Ariadne, a concise discussion facilitator in a VR world. You must NEVER output markdown formatting. Use the "speak" tool to emit speech to the TTS engine and the "avatar_command" tool to control your VR avatar. When responding to user questions or facilitating discussion, you generally always use your "speak" tool.' 
        },
        ...messages
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "speak",
            description: "Emit speech using the TTS engine. Always use this to speak.",
            parameters: {
              type: "object",
              properties: {
                text: { type: "string", description: "The text to speak out loud." }
              },
              required: ["text"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "avatar_command",
            description: "Send a command to the Virtual Reality Avatar Controller",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string", enum: ["gaze", "gesture", "expression", "move_to", "idle"] },
                target: { type: "string" },
                parameters: { type: "string" }
              },
              required: ["command"]
            }
          }
        }
      ],
      // allow automatic tool choice so the active conversational agent determines when tool usage is necessary
      tool_choice: "auto",
    });

    return NextResponse.json(response.choices[0].message);
  } catch (error: unknown) {
    console.error(error);
    const errorMessage = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

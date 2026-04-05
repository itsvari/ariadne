import OpenAI from 'openai';
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatProvider,
  ToolCall,
} from '@ariadne/shared-contracts';

interface OpenRouterMessage {
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: ToolCall[];
}

interface OpenRouterResponse {
  choices?: Array<{ message?: OpenRouterMessage }>;
}

export class OpenRouterChatProvider implements ChatProvider {
  private client: OpenAI;

  constructor(
    apiKey = process.env.OPENROUTER_API_KEY,
    baseURL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  ) {
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_NAME ?? 'Project Ariadne',
      },
    });
  }

  async complete(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const responseValue = (await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages as Parameters<typeof this.client.chat.completions.create>[0]['messages'],
      tools: params.tools,
      tool_choice: params.toolChoice as Parameters<typeof this.client.chat.completions.create>[0]['tool_choice'],
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      top_p: params.topP,
    })) as unknown as OpenRouterResponse;

    const message = responseValue.choices?.[0]?.message;
    if (!message) {
      throw new Error('OpenRouter returned no assistant message');
    }

    const content = Array.isArray(message.content)
      ? message.content
          .map((item) => ('text' in item ? item.text ?? '' : ''))
          .join('')
      : message.content;

    return {
      content,
      tool_calls: message.tool_calls,
      raw: responseValue,
    };
  }
}

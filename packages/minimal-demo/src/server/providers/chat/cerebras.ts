import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type {
  ChatProvider,
  ChatCompletionParams,
  ChatCompletionResult,
} from '../../contracts/ai';

interface CerebrasMessage {
  content?: string | null;
  tool_calls?: unknown;
}

interface CerebrasResponse {
  choices?: Array<{ message?: CerebrasMessage }>;
}

export class CerebrasChatProvider implements ChatProvider {
  private client: Cerebras;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.CEREBRAS_API_KEY;
    if (!key) {
      throw new Error('CEREBRAS_API_KEY is not configured');
    }
    this.client = new Cerebras({ apiKey: key });
  }

  async complete(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const createParams: Record<string, unknown> = {
      messages: params.messages,
      model: params.model,
    };

    if (params.tools) createParams.tools = params.tools;
    if (params.toolChoice) createParams.tool_choice = params.toolChoice;
    if (params.maxTokens) createParams.max_completion_tokens = params.maxTokens;
    if (params.temperature !== undefined) createParams.temperature = params.temperature;
    if (params.topP !== undefined) createParams.top_p = params.topP;
    if (params.reasoningEffort) createParams.reasoning_effort = params.reasoningEffort;

    const raw: unknown = await this.client.chat.completions.create(
      createParams as unknown as Parameters<typeof this.client.chat.completions.create>[0],
    );

    const response = raw as CerebrasResponse;
    const message = response.choices?.[0]?.message;
    if (!message) {
      throw new Error('Cerebras returned no assistant message');
    }

    return { content: message.content, tool_calls: message.tool_calls };
  }
}

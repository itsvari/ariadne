import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatProvider,
  ToolCall,
} from '@ariadne/shared-contracts';

interface CerebrasMessage {
  content?: string | null;
  tool_calls?: ToolCall[];
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
    const request: Record<string, unknown> = {
      messages: params.messages,
      model: params.model,
    };

    if (params.tools) request.tools = params.tools;
    if (params.toolChoice) request.tool_choice = params.toolChoice;
    if (params.maxTokens) request.max_completion_tokens = params.maxTokens;
    if (params.temperature !== undefined) request.temperature = params.temperature;
    if (params.topP !== undefined) request.top_p = params.topP;
    if (params.reasoningEffort) request.reasoning_effort = params.reasoningEffort;

    const responseValue = (await this.client.chat.completions.create(
      request as unknown as Parameters<typeof this.client.chat.completions.create>[0],
    )) as unknown as CerebrasResponse;

    const message = responseValue.choices?.[0]?.message;
    if (!message) {
      throw new Error('Cerebras returned no assistant message');
    }

    return {
      content: message.content,
      tool_calls: message.tool_calls,
      raw: responseValue,
    };
  }
}

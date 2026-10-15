import type { ChatClient, ChatMessage, ToolCall } from './agent.js';

interface GeminiResponse {
  model?: string;
  usage?: unknown;
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
}

export class GeminiClient implements ChatClient {
  constructor(private readonly apiKey: string, private readonly model: string) {
    if (!apiKey || !model) throw new Error('Gemini API key and model are required');
  }

  async complete(messages: ChatMessage[], tools: unknown[], signal: AbortSignal) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), temperature: 0, max_tokens: 8192 }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Gemini API key is invalid or lacks access to the selected model');
      if (response.status === 429) throw new Error('Gemini model is rate limited or its quota is exhausted');
      throw new Error(`Gemini request failed with status ${response.status}`);
    }
    const body = await response.json() as GeminiResponse;
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('Gemini returned no message');
    return { message: { content: message.content ?? null, tool_calls: message.tool_calls }, model: body.model ?? this.model, usage: body.usage };
  }
}

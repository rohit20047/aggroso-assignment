import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '../src/gemini.js';

afterEach(() => vi.unstubAllGlobals());

describe('Gemini gateway', () => {
  it('uses the Gemini endpoint and keeps the key out of the payload', async () => {
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      expect(options.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      expect(body.model).toBe('gemini-3.8-flash');
      expect(body).not.toHaveProperty('tools');
      expect(JSON.stringify(body)).not.toContain('test-key');
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: '{}', role: 'assistant' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new GeminiClient('test-key', 'gemini-3.8-flash').complete([{ role: 'user', content: 'Plan a migration' }], [], new AbortController().signal);
    expect(result.message.content).toBe('{}');
  });

  it('forwards supported tools when provided by the planner', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)) as { tools: unknown[]; tool_choice: string };
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toBe('auto');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}', role: 'assistant' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await new GeminiClient('test-key', 'gemini-3.8-flash').complete([{ role: 'user', content: 'Plan a migration' }], [{ type: 'function' }], new AbortController().signal);
  });
});

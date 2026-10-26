import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OllamaProvider } from './ollama.ts';
import { OpenAiCompatibleProvider } from './openai-compatible.ts';
import type { ChatRequest } from './provider.ts';

interface Received {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Handler = (received: Received, response: ServerResponse) => void;

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A stand-in model server on a free port that records every request. */
async function stub(handler: Handler): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk: Buffer) => (data += chunk.toString()));
    request.on('end', () => {
      const entry = {
        url: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(data || '{}') as Record<string, unknown>,
      };
      received.push(entry);
      handler(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** The error a call fails with, to check its code and message. */
async function failure(call: Promise<unknown>): Promise<Error & { code?: string }> {
  const error = await call.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error('expected the call to fail');
  return error;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const request: ChatRequest = {
  model: 'qwen2.5-coder:7b',
  messages: [
    { role: 'system', content: 'Reply in JSON.' },
    { role: 'user', content: 'Name the tool.' },
  ],
  format: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  purpose: 'name_tool',
  options: { num_ctx: 8192, num_predict: 2048, temperature: 0, seed: 42, keep_alive: '30m' },
};

describe('OllamaProvider', () => {
  it('sends the schema, context window and keep-alive, and reads the token counts', async () => {
    const server = await stub((_received, response) =>
      json(response, 200, {
        model: 'qwen2.5-coder:7b',
        message: { role: 'assistant', content: '{"name":"list_orders"}' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 41,
        eval_count: 9,
      }),
    );
    const reply = await new OllamaProvider(server.url).chat(request);
    expect(reply).toMatchObject({
      content: '{"name":"list_orders"}',
      prompt_tokens: 41,
      completion_tokens: 9,
      truncated: false,
    });

    const [sent] = server.received;
    expect(sent?.url).toBe('/api/chat');
    expect(sent?.body).toMatchObject({
      model: 'qwen2.5-coder:7b',
      stream: false,
      keep_alive: '30m',
      format: request.format,
      options: { num_ctx: 8192, num_predict: 2048, temperature: 0, seed: 42 },
    });
    expect(sent?.body).not.toHaveProperty('purpose');
  });

  it('says how to download a missing model', async () => {
    const server = await stub((_received, response) =>
      json(response, 404, { error: "model 'qwen2.5-coder:7b' not found" }),
    );
    const error = await failure(new OllamaProvider(server.url).chat(request));
    expect(error.code).toBe('llm_unavailable');
    expect(error.message).toContain('ollama pull qwen2.5-coder:7b');
  });

  it('reports an Ollama that is not running', async () => {
    const server = await stub(() => undefined);
    servers.pop()?.close();
    const error = await failure(new OllamaProvider(server.url).chat(request));
    expect(error.code).toBe('llm_unavailable');
    expect(error.message).toContain('is it running?');
  });

  it('gives up on a call that takes too long', async () => {
    const server = await stub(() => undefined);
    const error = await failure(new OllamaProvider(server.url, { timeoutMs: 100 }).chat(request));
    expect(error.code).toBe('llm_unavailable');
    expect(error.message).toContain('did not reply within');
  });
});

describe('OpenAiCompatibleProvider', () => {
  const completion = (content: string, finish = 'stop') => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 30, completion_tokens: 7 },
  });

  it('asks for a JSON schema and sends the API key it was given', async () => {
    const server = await stub((_received, response) => json(response, 200, completion('{"name":"a"}')));
    const provider = new OpenAiCompatibleProvider(`${server.url}/v1/`, { apiKey: 'test-key-not-real' });
    await expect(provider.chat(request)).resolves.toMatchObject({
      content: '{"name":"a"}',
      prompt_tokens: 30,
      completion_tokens: 7,
    });

    const [sent] = server.received;
    expect(sent?.url).toBe('/v1/chat/completions');
    expect(sent?.headers.authorization).toBe('Bearer test-key-not-real');
    expect(sent?.body).toMatchObject({
      model: 'qwen2.5-coder:7b',
      temperature: 0,
      seed: 42,
      max_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name: 'name_tool', schema: request.format } },
    });
  });

  it('falls back to JSON mode, then to no format, on servers that refuse them', async () => {
    const server = await stub((received, response) => {
      const format = received.body.response_format as { type: string } | undefined;
      if (format)
        json(response, 400, { error: { message: `response_format ${format.type} is not supported` } });
      else json(response, 200, completion('{"name":"a"}', 'length'));
    });
    const provider = new OpenAiCompatibleProvider(`${server.url}/v1`);
    await expect(provider.chat(request)).resolves.toMatchObject({ truncated: true });
    expect(
      server.received.map((r) => (r.body.response_format as { type?: string } | undefined)?.type),
    ).toEqual(['json_schema', 'json_object', undefined]);
    // The server's limits are remembered.
    await provider.chat(request);
    expect(server.received).toHaveLength(4);
    expect(server.received[3]?.body).not.toHaveProperty('response_format');
  });

  it('reports errors without retrying them', async () => {
    const server = await stub((_received, response) => json(response, 500, { error: 'out of memory' }));
    const error = await failure(new OpenAiCompatibleProvider(`${server.url}/v1`).chat(request));
    expect(error.code).toBe('llm_unavailable');
    expect(error.message).toContain('500');
    expect(server.received).toHaveLength(1);
  });
});

import { recipeSchema } from '@tooldrop/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider, RecordingProvider, type FakeReply } from './fake.ts';
import { modelSchema, parseReply } from './json.ts';
import { Llm, MAX_RETRIES } from './llm.ts';
import { Masker } from './redact.ts';
import type { LlmCallRecord } from './usage.ts';
import { usageTotals } from './usage.ts';

const answerSchema = z.strictObject({ name: z.string().regex(/^[a-z_]+$/), count: z.number().int() });
const models = { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' };

function setup(replies: Record<string, FakeReply[]>, options: { endpoint?: string } = {}) {
  const provider = new FakeProvider(replies, options);
  const calls: LlmCallRecord[] = [];
  const llm = new Llm({ provider, models, onCall: (record) => calls.push(record) });
  const ask = (overrides: { prompt?: string; masker?: Masker } = {}) =>
    llm.generateJson({
      role: 'code',
      purpose: 'name_tool',
      schema: answerSchema,
      system: 'You name tools.',
      prompt: overrides.prompt ?? 'Name the tool.',
      job_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      ...(overrides.masker && { masker: overrides.masker }),
    });
  return { provider, calls, ask };
}

describe('Llm.generateJson', () => {
  it('returns a reply that matches the schema, asking for it with constrained decoding', async () => {
    const { provider, calls, ask } = setup({ name_tool: [{ name: 'list_orders', count: 3 }] });
    await expect(ask()).resolves.toEqual({ name: 'list_orders', count: 3 });

    const [request] = provider.requests;
    expect(request?.model).toBe('qwen2.5-coder:7b');
    expect(request?.format).toMatchObject({ type: 'object', required: ['name', 'count'] });
    expect(request?.options).toMatchObject({ num_ctx: 8192, temperature: 0, seed: 42, keep_alive: '30m' });
    expect(calls).toEqual([
      expect.objectContaining({
        purpose: 'name_tool',
        attempt: 1,
        ok: true,
        provider: 'ollama',
        role: 'code',
      }),
    ]);
  });

  it('retries with the validation errors, and logs every attempt', async () => {
    const { provider, calls, ask } = setup({
      name_tool: ['not json', { name: 'List Orders', count: 3 }, { name: 'list_orders', count: 3 }],
    });
    await expect(ask()).resolves.toEqual({ name: 'list_orders', count: 3 });

    const second = provider.requests[1]?.messages.at(-1)?.content;
    expect(second).toMatch(/not valid JSON/);
    const third = provider.requests[2]?.messages;
    expect(third?.at(-2)).toEqual({ role: 'assistant', content: '{"name":"List Orders","count":3}' });
    expect(third?.at(-1)?.content).toMatch(/^- name: Invalid string/m);
    expect(third).toHaveLength(4);
    expect(calls.map((call) => [call.attempt, call.ok, call.error_code])).toEqual([
      [1, false, 'llm_invalid_output'],
      [2, false, 'llm_invalid_output'],
      [3, true, undefined],
    ]);
    expect(usageTotals(calls)).toMatchObject({ calls: 3, retries: 2 });
  });

  it(`fails after ${MAX_RETRIES} retries with the last validation error`, async () => {
    const bad = { name: 'x', count: 'many' };
    const { calls, ask } = setup({ name_tool: [bad, bad, bad, bad, bad] });
    const error = await ask().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'llm_invalid_output',
      details: { purpose: 'name_tool', problems: [expect.stringMatching(/^count: Invalid input/)] },
    });
    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it('masks secrets in every prompt, local or not', async () => {
    const { provider, ask } = setup({ name_tool: [{ name: 'a', count: 1 }] });
    const masker = new Masker().add('cookie-value-99', '{{session.cookie}}');
    await ask({ prompt: 'Cookie cookie-value-99 and {"password": "hunter22"}', masker });
    const sent = JSON.stringify(provider.requests[0]?.messages);
    expect(sent).not.toMatch(/cookie-value-99|hunter22/);
    expect(sent).toContain('{{session.cookie}}');
  });

  it('redacts PII only when prompts leave the machine', async () => {
    const prompt = 'Customer ana@example.test, phone +1 415 555 0134';
    const local = setup({ name_tool: [{ name: 'a', count: 1 }] });
    await local.ask({ prompt });
    expect(JSON.stringify(local.provider.requests[0]?.messages)).toContain('ana@example.test');

    const external = setup(
      { name_tool: [{ name: 'a', count: 1 }] },
      { endpoint: 'https://llm.example.test/v1' },
    );
    await external.ask({ prompt });
    const sent = JSON.stringify(external.provider.requests[0]?.messages);
    expect(sent).not.toMatch(/ana@example\.test|415/);
    expect(sent).toContain('[email]');
  });

  it('refuses a prompt over budget before calling the model', async () => {
    const { provider, ask } = setup({ name_tool: [{ name: 'a', count: 1 }] });
    await expect(ask({ prompt: 'x'.repeat(20_000) })).rejects.toMatchObject({ code: 'llm_prompt_too_large' });
    expect(provider.requests).toHaveLength(0);
  });
});

describe('recorded replies', () => {
  it('records replies by purpose, and replays them in order', async () => {
    const recorder = new RecordingProvider(new FakeProvider({ name_tool: [{ name: 'b', count: 2 }] }));
    const llm = new Llm({ provider: recorder, models });
    await llm.generateJson({
      role: 'code',
      purpose: 'name_tool',
      schema: answerSchema,
      system: 's',
      prompt: 'p',
    });
    const recorded = recorder.recorded();
    expect(recorded).toMatchObject({
      models: ['qwen2.5-coder:7b'],
      replies: { name_tool: ['{"name":"b","count":2}'] },
    });

    const replay = new FakeProvider(recorded.replies);
    const again = new Llm({ provider: replay, models });
    await expect(
      again.generateJson({
        role: 'code',
        purpose: 'name_tool',
        schema: answerSchema,
        system: 's',
        prompt: 'p',
      }),
    ).resolves.toEqual({ name: 'b', count: 2 });
    expect(replay.remaining()).toEqual({ name_tool: 0 });
  });
});

describe('model schemas and replies', () => {
  it('keeps what decoders understand and drops the rest', () => {
    const schema = modelSchema(
      z.object({
        id: z.string().regex(/^[a-z]+$/),
        path: z.string().regex(/^\$/),
        when: z.iso.date(),
        site: z.url(),
        tags: z.record(z.string().regex(/^[a-z]+$/), z.string()),
        count: z.number().int(),
      }),
    );
    expect(schema).not.toHaveProperty('$schema');
    expect(schema.properties).toMatchObject({
      id: { pattern: '^[a-z]+$' },
      count: { type: 'integer' },
    });
    const { path, site, tags, count } = schema.properties as Record<string, Record<string, unknown>>;
    expect(path).not.toHaveProperty('pattern');
    expect(site).not.toHaveProperty('format');
    expect(tags).not.toHaveProperty('propertyNames');
    expect(count).not.toHaveProperty('minimum');
  });

  it('turns the whole recipe schema into one a grammar can follow', () => {
    const text = JSON.stringify(modelSchema(recipeSchema));
    expect(text).not.toContain('"pattern":"^\\\\$"');
    expect(text).toContain('"const":"http"');
  });

  it('reads JSON inside a code fence', () => {
    expect(parseReply('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    const broken = parseReply('{"a":');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error).toMatch(/^not valid JSON/);
  });
});

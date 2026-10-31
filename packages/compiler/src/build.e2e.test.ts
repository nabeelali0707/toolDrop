import type { Recording, Step } from '@tooldrop/core';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider, Llm, type ChatRequest, type FakeReply, type LlmCallRecord } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTool, RECORDING_QUESTION, type BuildHooks, type BuildResult } from './build.ts';
import { CaptureSession } from './capture/capture.ts';
import type { PageSnapshot } from './capture/page-helpers.ts';
import { toRecording } from './recording/replay.ts';

// The build pipeline end to end on the fixtures, with scripted model replies
// (CI never calls a model, DECISIONS.md, D-019). The scripted "model" reads
// the draft out of its prompt and renames a field, as a real one would.

let browser: Browser;
let runtime: Runtime;
let jsonApi: RunningFixture;
let htmlApp: RunningFixture;
const fast = { per_second: 200, concurrency: 4, burst: 200 };

beforeAll(async () => {
  browser = await chromium.launch();
  runtime = new Runtime({ browserWaitMs: 5_000 });
  jsonApi = await startJsonApiFixture();
  htmlApp = await startHtmlAppFixture();
});

afterAll(async () => {
  await runtime.close();
  await browser.close();
  await jsonApi.close();
  await htmlApp.close();
});

const prompt = (request: ChatRequest) => request.messages.find((m) => m.role === 'user')?.content ?? '';

/** The draft recipe the prompt carries, on its own line. */
function draftIn(request: ChatRequest): { strategy: string; steps: Step[] } {
  const line = prompt(request)
    .split('\n')
    .find((text) => text.startsWith('{"strategy"'));
  if (!line) throw new Error('no draft in the prompt');
  return JSON.parse(line) as { strategy: string; steps: Step[] };
}

/** A reviewing model: returns the draft with "date" renamed to "issued_on". */
const reviewDraft: FakeReply = (request) => {
  const draft = draftIn(request);
  return JSON.parse(JSON.stringify(draft).replaceAll('"date":', '"issued_on":')) as Record<string, unknown>;
};

/** The ref of an element in the page list of an explore prompt. */
function refIn(request: ChatRequest, element: string): string {
  const match = new RegExp(`\\[(e\\d+)\\] ${element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(
    prompt(request),
  );
  if (!match?.[1]) throw new Error(`no ${element} on the page`);
  return match[1];
}

const description = {
  name: 'list_invoices',
  description: 'List supplier invoices, newest first, optionally only those with a given status.',
  inputs: [{ name: 'status', description: 'Only invoices with this status.', required: false }],
  fields: [{ name: 'number', description: 'The invoice number.' }],
};

function setup(replies: Record<string, FakeReply[]>, recordings: Record<string, Recording> = {}) {
  const provider = new FakeProvider(replies);
  const calls: LlmCallRecord[] = [];
  const llm = new Llm({
    provider,
    models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' },
    onCall: (c) => calls.push(c),
  });
  const steps: string[] = [];
  const questions: string[] = [];
  const answers: string[] = [];
  const hooks: BuildHooks = {
    step: (name) => {
      steps.push(name);
    },
    ask: (question) => {
      questions.push(question.text);
      return Promise.resolve(answers.shift() ?? 'no answer');
    },
    recording: (id) => {
      const recording = recordings[id];
      if (!recording) throw new Error(`no recording ${id}`);
      return recording;
    },
  };
  const deps = { llm, runtime, browser, rateLimit: fast, waitMs: 5_000, nameTaken: () => false };
  return { provider, calls, steps, questions, answers, hooks, deps };
}

const ref = (snapshot: PageSnapshot, role: string, name?: string) => {
  const node = snapshot.nodes.find((n) => n.role === role && (name === undefined || n.name === name));
  if (!node) throw new Error(`no ${role} ${name ?? ''}`);
  return node.ref;
};

/** What `tooldrop record` would save: pick a status, search, mark the table. */
async function record(url: string, status: string): Promise<Recording> {
  const session = await CaptureSession.start(url, { browser });
  const page = await session.snapshot();
  await session.select(ref(page, 'combobox', 'Status'), status, { name: 'status' });
  await session.click(ref(page, 'button', 'Search'));
  await session.markTarget(ref(await session.snapshot(), 'table'));
  return toRecording(await session.finish(), { recorder: 'cli' });
}

describe('building from a recording', () => {
  let built: BuildResult;
  let calls: LlmCallRecord[];

  beforeAll(async () => {
    const recording = await record(jsonApi.url, 'paid');
    const run = setup({
      clarify: [{ questions: [] }],
      write_recipe: [reviewDraft],
      describe_tool: [description],
    });
    built = await buildTool(
      { url: jsonApi.url, task: 'List my invoices by status', authority: 'read', recording },
      run.deps,
      run.hooks,
    );
    calls = run.calls;
    expect(run.provider.remaining()).toEqual({ clarify: 0, write_recipe: 0, describe_tool: 0 });
  }, 120_000);

  it('builds an http_replay tool with a browser fallback, without exploring', () => {
    expect(built.strategy).toBe('http_replay');
    expect(built.attempts).toBe(1);
    expect(calls.map((call) => call.purpose)).toEqual(['clarify', 'write_recipe', 'describe_tool']);
    expect(built.tool.name).toBe('list_invoices');
    const fallback = built.tool.recipe.fallback?.steps.at(-1);
    expect(fallback).toMatchObject({
      op: 'extract_table',
      columns: {
        number: 'Number',
        supplier: 'Supplier',
        issued_on: 'Date',
        amount: 'Amount',
        status: 'Status',
      },
    });
    expect(built.tool.recipe.fallback?.steps).toContainEqual(
      expect.objectContaining({ op: 'click', repeat: { max: 20 } }),
    );
  });

  it('infers the schemas from the captured values and describes them', () => {
    expect(built.tool.input_schema).toEqual({
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'paid', 'overdue', 'draft'],
          description: 'Only invoices with this status.',
        },
      },
      additionalProperties: false,
    });
    expect(built.tool.output_schema).toMatchObject({
      type: 'array',
      items: {
        properties: {
          number: { type: 'string', description: 'The invoice number.' },
          issued_on: { type: 'string', format: 'date' },
          amount: { type: 'number' },
        },
        required: ['number', 'supplier', 'issued_on', 'amount', 'status'],
      },
    });
  });

  it('validated it on three input sets and keeps them', () => {
    expect(built.test_inputs).toEqual([{ status: 'paid' }, { status: 'open' }, {}]);
    expect(built.sample).toHaveLength(3);
    expect((built.sample as { status: string }[]).every((row) => row.status === 'paid')).toBe(true);
  });
});

describe('building by exploring', () => {
  it('lets the reasoning model drive the page when there is no recording', async () => {
    const run = setup({
      explore: [
        (request) => ({
          action: 'select',
          ref: refIn(request, 'combobox "Status"'),
          value: 'Overdue',
          input: 'status',
          reason: 'the task filters by status',
        }),
        (request) => ({
          action: 'click',
          ref: refIn(request, 'button "Search"'),
          reason: 'apply the filter',
        }),
        (request) => ({ action: 'extract', ref: refIn(request, 'table'), reason: 'the invoices are here' }),
      ],
      clarify: [{ questions: [] }],
      write_recipe: [reviewDraft],
      describe_tool: [description],
    });
    const built = await buildTool(
      { url: jsonApi.url, task: 'List overdue invoices', authority: 'read' },
      run.deps,
      run.hooks,
    );
    expect(built.strategy).toBe('http_replay');
    expect(run.calls.filter((call) => call.purpose === 'explore')).toHaveLength(3);
    expect(built.test_inputs[0]).toEqual({ status: 'overdue' });
    // The explore prompt shows the page, never a CSRF token or cookie.
    const explorePrompts = run.provider.requests
      .filter((r) => r.purpose === 'explore')
      .map(prompt)
      .join('\n');
    expect(explorePrompts).toContain('[e');
    expect(explorePrompts).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  }, 120_000);

  it('asks for a recording when the agent gives up', async () => {
    const recording = await record(jsonApi.url, 'draft');
    const run = setup(
      {
        explore: [{ action: 'give_up', reason: 'no invoices on this page' }],
        clarify: [{ questions: [] }],
        write_recipe: [reviewDraft],
        describe_tool: [description],
      },
      { '01KRECORDINGXXXXXXXXXXXXXX': recording },
    );
    run.answers.push('01KRECORDINGXXXXXXXXXXXXXX');
    const built = await buildTool(
      { url: jsonApi.url, task: 'List invoices', authority: 'read' },
      run.deps,
      run.hooks,
    );
    expect(run.questions).toEqual([`${RECORDING_QUESTION} (no invoices on this page)`]);
    expect(built.test_inputs[0]).toEqual({ status: 'draft' });
  }, 120_000);
});

describe('building for a server-rendered site', () => {
  it('picks html_fetch when the page itself holds the data', async () => {
    const recording = await record(`${htmlApp.url}/invoices`, 'overdue');
    const run = setup({
      clarify: [{ questions: [] }],
      write_recipe: [reviewDraft],
      describe_tool: [description],
    });
    const built = await buildTool(
      { url: `${htmlApp.url}/invoices`, task: 'Search invoices by status', authority: 'read', recording },
      run.deps,
      run.hooks,
    );
    expect(built.strategy).toBe('html_fetch');
    expect(built.tool.recipe.steps[0]).toMatchObject({ op: 'http', url: '{{site}}/invoices' });
    expect(built.test_inputs).toHaveLength(3);
  }, 120_000);
});

describe('validation failures', () => {
  it('sends a recipe that disagrees with the browser back to the model with the error', async () => {
    const recording = await record(jsonApi.url, 'paid');
    // The first reply reads the currency into "amount".
    const wrong: FakeReply = (request) =>
      JSON.parse(JSON.stringify(draftIn(request)).replace('"$.total.value"', '"$.total.currency"')) as Record<
        string,
        unknown
      >;
    const run = setup({
      clarify: [{ questions: [] }],
      write_recipe: [wrong, reviewDraft],
      describe_tool: [description],
    });
    const built = await buildTool(
      { url: jsonApi.url, task: 'List invoices by status', authority: 'read', recording },
      run.deps,
      run.hooks,
    );
    expect(built.attempts).toBe(2);
    const second = prompt(run.provider.requests.filter((r) => r.purpose === 'write_recipe')[1]!);
    expect(second).toMatch(/The last recipe failed when it ran: .*disagree.*amount/);
  }, 120_000);

  it('refuses write tools until safe mode exists', async () => {
    const run = setup({});
    await expect(
      buildTool({ url: jsonApi.url, task: 'Pay an invoice', authority: 'write' }, run.deps, run.hooks),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

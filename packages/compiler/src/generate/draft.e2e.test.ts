import { recipeSchema, type JsonSchema } from '@tooldrop/core';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyRequest } from '../analyze/classify.ts';
import { rankExchanges, type HtmlCandidate, type JsonCandidate } from '../analyze/rank.ts';
import { CaptureSession, type Capture } from '../capture/capture.ts';
import type { PageSnapshot } from '../capture/page-helpers.ts';
import { browserDraft, htmlDraft, jsonDraft, type Draft } from './draft.ts';

let browser: Browser;
let runtime: Runtime;
const fixtures: RunningFixture[] = [];

const ref = (snapshot: PageSnapshot, role: string, name?: string) => {
  const node = snapshot.nodes.find((n) => n.role === role && (name === undefined || n.name === name));
  if (!node) throw new Error(`no ${role} ${name ?? ''}`);
  return node.ref;
};

/** What a person does on both invoice fixtures: pick a status, search, point at the table. */
async function captureSearch(url: string, status: string): Promise<Capture> {
  const session = await CaptureSession.start(url, { browser });
  const page = await session.snapshot();
  await session.select(ref(page, 'combobox', 'Status'), status, { name: 'status' });
  await session.click(ref(page, 'button', 'Search'));
  await session.markTarget(ref(await session.snapshot(), 'table'));
  return session.finish();
}

/** Runs a draft as the runtime would run a published tool. */
function run(draft: Draft, site: string, input: Record<string, unknown>) {
  const recipe = recipeSchema.parse({ strategy: draft.strategy, steps: draft.steps });
  const schema: JsonSchema = { type: 'object', properties: { status: { type: 'string' } } };
  return runtime.run(
    {
      name: 'draft',
      authority: 'read',
      input_schema: schema,
      output_schema: {},
      version: 0,
      recipe,
      site,
      rate_limit: { per_second: 200, concurrency: 4, burst: 200 },
    },
    input,
  );
}

beforeAll(async () => {
  browser = await chromium.launch();
  runtime = new Runtime({ browserWaitMs: 5_000 });
});

afterAll(async () => {
  await runtime.close();
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
});

describe('drafts for the JSON-API fixture', () => {
  let fixture: RunningFixture;
  let capture: Capture;
  let candidate: JsonCandidate;

  beforeAll(async () => {
    fixture = await startJsonApiFixture();
    fixtures.push(fixture);
    capture = await captureSearch(fixture.url, 'paid');
    const best = rankExchanges(capture)[0];
    if (best?.kind !== 'json') throw new Error(`expected a JSON candidate, got ${best?.kind}`);
    candidate = best;
  }, 60_000);

  it('finds the API call behind the table and the value behind each column', () => {
    expect(candidate.exchange.url).toBe(`${fixture.url}/api/v2/invoices/search`);
    expect(candidate.score).toBe(1);
    expect(candidate.items).toBe('$.items[*]');
    expect(candidate.columns.map((c) => [c.header, c.path, c.exact])).toEqual([
      ['Number', '$.invoiceNo', true],
      ['Supplier', '$.supplier', true],
      ['Date', '$.issuedOn', true],
      ['Amount', '$.total.value', true],
      ['Status', '$.state', true],
    ]);
    expect(capture.target?.more?.label).toBe('button "Load more"');
  });

  it('classifies every part of the request', () => {
    const analysis = classifyRequest(capture, candidate.exchange, candidate.items);
    const kinds = Object.fromEntries(
      analysis.fields.map((field) => [`${field.location} ${field.name}`, field.kind]),
    );
    expect(kinds).toMatchObject({
      'body status': 'user_input',
      'body from': 'constant',
      'body page': 'pagination',
      'header x-csrf-token': 'auth',
    });
    expect(analysis.pagination).toMatchObject({
      mode: 'page',
      variable: 'page',
      start: 1,
      until: '$.hasMore == false',
    });
    const csrf = analysis.fields.find((field) => field.name === 'x-csrf-token');
    expect(csrf?.from).toMatchObject({
      kind: 'page',
      selector: 'meta[name="csrf-token"]',
      attribute: 'content',
    });
    expect(csrf?.value).toBe('{{vars.csrf_token}}');
    expect(analysis.prerequisites.map((e) => e.url)).toEqual([`${fixture.url}/`]);
    expect(analysis.blockers).toEqual([]);
  });

  it('drafts an http_replay recipe that returns every page, like the browser does', async () => {
    const analysis = classifyRequest(capture, candidate.exchange, candidate.items);
    const draft = jsonDraft(candidate, analysis, fixture.url);
    expect(draft.steps).toEqual([
      { op: 'http', method: 'GET', url: '{{site}}/' },
      {
        op: 'extract_text',
        target: [{ kind: 'css', value: 'meta[name="csrf-token"]' }],
        attribute: 'content',
        save: 'csrf_token',
      },
      {
        op: 'http',
        method: 'POST',
        url: '{{site}}/api/v2/invoices/search',
        headers: { 'x-csrf-token': '{{vars.csrf_token}}' },
        body: { status: '{{input.status}}', from: '', page: '{{loop.page}}' },
        paginate: { var: 'page', until: '$.hasMore == false', start: 1 },
      },
      {
        op: 'map',
        path: '$.items[*]',
        fields: {
          number: '$.invoiceNo',
          supplier: '$.supplier',
          date: '$.issuedOn',
          amount: '$.total.value',
          status: '$.state',
        },
      },
    ]);

    const replayed = await run(draft, fixture.url, { status: 'paid' });
    const rows = replayed.result as { number: string; status: string; amount: number }[];
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((row) => row.status === 'paid')).toBe(true);

    const browsed = await run(browserDraft(capture, fixture.url, draft.bindings), fixture.url, {
      status: 'paid',
    });
    const browserRows = browsed.result as { number: string; amount: string }[];
    expect(browserRows.map((row) => row.number)).toEqual(rows.map((row) => row.number));
    expect(browserRows.map((row) => Number(row.amount))).toEqual(rows.map((row) => row.amount));
  }, 60_000);
});

describe('drafts for the server-rendered fixture', () => {
  let fixture: RunningFixture;
  let capture: Capture;

  beforeAll(async () => {
    fixture = await startHtmlAppFixture();
    fixtures.push(fixture);
    capture = await captureSearch(`${fixture.url}/invoices`, 'overdue');
  }, 60_000);

  it('finds the page that holds the data, since there is no API', () => {
    const [best] = rankExchanges(capture);
    expect(best?.kind).toBe('html');
    expect(best?.exchange.url).toBe(`${fixture.url}/invoices?status=overdue&from=`);
  });

  it('drafts an html_fetch recipe that reads the same table the browser shows', async () => {
    const candidate = rankExchanges(capture)[0] as HtmlCandidate;
    const analysis = classifyRequest(capture, candidate.exchange);
    const draft = htmlDraft(capture, candidate, analysis, fixture.url);
    expect(draft?.steps[0]).toEqual({
      op: 'http',
      method: 'GET',
      url: '{{site}}/invoices',
      query: { status: '{{input.status}}', from: '' },
    });
    if (!draft) return;
    const fetched = await run(draft, fixture.url, { status: 'draft' });
    const rows = fetched.result as { status: string }[];
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.status === 'draft')).toBe(true);

    const browsed = await run(browserDraft(capture, fixture.url, draft.bindings), fixture.url, {
      status: 'draft',
    });
    expect(browsed.result).toEqual(fetched.result);
  }, 60_000);
});

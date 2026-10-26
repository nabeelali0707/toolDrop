import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureSession, type Capture } from './capture.ts';
import type { Har } from './har.ts';
import type { AxNode, PageSnapshot } from './page-helpers.ts';
import { writeCapture } from './store.ts';

let fixture: RunningFixture;
let browser: Browser;
let capture: Capture;
let first: PageSnapshot;

function node(snapshot: PageSnapshot, role: string, name?: string): AxNode {
  const found = snapshot.nodes.find((n) => n.role === role && (name === undefined || n.name === name));
  if (!found) throw new Error(`no ${role} "${name}" in ${JSON.stringify(snapshot.nodes)}`);
  return found;
}

beforeAll(async () => {
  fixture = await startJsonApiFixture();
  browser = await chromium.launch();

  // What a user, or the explore agent, does to list paid invoices.
  const session = await CaptureSession.start(fixture.url, { browser });
  first = await session.snapshot();
  await session.select(node(first, 'combobox', 'Status').ref, 'Paid', { name: 'status' });
  await session.click(node(first, 'button', 'Search').ref);
  await session.markTarget(node(await session.snapshot(), 'table').ref);
  capture = await session.finish();
}, 60_000);

afterAll(async () => {
  await browser.close();
  await fixture.close();
});

describe('a capture on the JSON-API fixture', () => {
  it('sees the page as a small accessibility tree', () => {
    expect(first.title).toBe('Invoices');
    expect(node(first, 'combobox', 'Status')).toMatchObject({
      value: 'All',
      options: ['All', 'Open', 'Paid', 'Overdue', 'Draft'],
    });
    expect(node(first, 'textbox', 'From')).toBeDefined();
    expect(node(first, 'table')).toMatchObject({
      columns: ['Number', 'Supplier', 'Date', 'Amount', 'Status'],
      rows: 10,
    });
    // The hidden "Load more" button, cells and the meta tags are not in it.
    expect(first.nodes.some((n) => n.name === 'Load more')).toBe(true);
    expect(first.nodes.every((n) => n.role !== 'cell')).toBe(true);
  });

  it('records actions with selectors that work on the live page', () => {
    expect(capture.actions.map((action) => action.kind)).toEqual(['goto', 'select', 'click']);
    const [, select, click] = capture.actions;
    expect(select).toMatchObject({ kind: 'select', label: 'combobox "Status"', value: 'paid' });
    expect(select?.kind === 'select' && select.target).toEqual([
      { kind: 'role', role: 'combobox', name: 'Status' },
      { kind: 'css', value: 'select[name="status"]' },
      { kind: 'css', value: '#search > label:nth-of-type(1) > select' },
    ]);
    expect(click).toMatchObject({ kind: 'click', label: 'button "Search"' });
    expect(click?.kind === 'click' && click.target).toEqual(
      expect.arrayContaining([
        { kind: 'role', role: 'button', name: 'Search' },
        { kind: 'test_id', value: 'search' },
        { kind: 'text', value: 'Search', exact: true },
      ]),
    );
    expect(capture.inputs).toEqual([{ name: 'status', action: 1, example: 'paid' }]);
  });

  it('reads the data on screen from the marked table', () => {
    expect(capture.target?.selector[0]).toEqual({ kind: 'role', role: 'table' });
    const data = capture.target?.data;
    expect(data?.kind).toBe('table');
    if (data?.kind !== 'table') return;
    expect(data.headers).toEqual(['Number', 'Supplier', 'Date', 'Amount', 'Status']);
    expect(data.rows).toHaveLength(10);
    expect(data.rows.every((row) => row[4] === 'paid')).toBe(true);
  });

  it('keeps the page and its API calls with bodies, and nothing else', () => {
    const kinds = capture.exchanges.map((e) => `${e.resource_type} ${e.method} ${new URL(e.url).pathname}`);
    expect(kinds).toEqual([
      'document GET /',
      'fetch POST /api/v2/invoices/search',
      'fetch POST /api/v2/invoices/search',
    ]);
    const search = capture.exchanges.at(-1);
    expect(search?.after_actions).toBe(2);
    expect(JSON.parse(search?.request_body ?? '{}')).toEqual({ status: 'paid', from: '', page: 1 });
    expect(search?.request_headers['x-csrf-token']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(search?.response_body ?? '{}')).toMatchObject({ hasMore: true, page: 1 });
  });

  it('masks cookies and tokens before writing the capture to disk', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-capture-'));
    try {
      const stored = writeCapture(capture, dataDir);
      expect(stored.har_path).toBe(`captures/${capture.id}/network.har`);
      const files = [
        stored.har_path,
        ...stored.dom_snapshots,
        ...stored.ax_trees,
        `captures/${capture.id}/capture.json`,
      ];
      for (const file of files) expect(existsSync(join(dataDir, file))).toBe(true);

      const csrf = capture.exchanges.at(-1)?.request_headers['x-csrf-token'] ?? '';
      const sid = /sid=([^;]+)/.exec(capture.exchanges[0]?.response_headers['set-cookie'] ?? '')?.[1] ?? '';
      expect(csrf.length).toBeGreaterThan(10);
      expect(sid.length).toBeGreaterThan(10);
      for (const file of files) {
        const text = readFileSync(join(dataDir, file), 'utf8');
        expect(text).not.toContain(csrf);
        expect(text).not.toContain(sid);
      }
      const har = JSON.parse(readFileSync(join(dataDir, stored.har_path), 'utf8')) as Har;
      const headers = har.log.entries.at(-1)?.request.headers ?? [];
      expect(headers.find((header) => header.name === 'x-csrf-token')?.value).toBe('[masked]');
      expect(har.log.entries.at(-1)?.response.content.text).toContain('INV-');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('replays recorded selectors in a new session', async () => {
    const session = await CaptureSession.start(fixture.url, { browser });
    try {
      const select = capture.actions[1];
      if (select?.kind !== 'select') throw new Error('expected a select action');
      await session.select(await session.refFor(select.target), select.value);
      const click = capture.actions[2];
      if (click?.kind !== 'click') throw new Error('expected a click action');
      await session.click(await session.refFor(click.target));
      const target = await session.markTarget(await session.refFor(capture.target?.selector ?? []));
      expect(target.data).toEqual(capture.target?.data);
    } finally {
      await session.abort();
    }
  });
});

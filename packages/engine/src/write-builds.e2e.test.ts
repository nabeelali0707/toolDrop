import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKeyStore } from '@tooldrop/auth';
import type { Recording } from '@tooldrop/core';
import type { DatabaseHandle } from '@tooldrop/db';
import { openTestDatabase } from '@tooldrop/db/testing';
import { startHtmlAppFixture, type Payment } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobView } from './builds.ts';
import { Engine } from './engine.ts';

// Write builds from recordings (D-058): a recorded form submission becomes a
// write tool whose submit is its commit step. The build itself never submits:
// the fixture's payments stay empty until a person approves a call.

let browser: Browser;
let fixture: RunningFixture;
let handle: DatabaseHandle;
let dataDir: string;
let engine: Engine;

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startHtmlAppFixture();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
beforeEach(async () => {
  await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });
  handle = await openTestDatabase();
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-write-builds-'));
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: {
      browser,
      models: {
        provider: new FakeProvider({
          describe_write: [
            {
              name: 'record_invoice_payment',
              description: 'Records a payment against an invoice. Changes data on the site.',
              inputs: [
                { name: 'invoice', description: 'The invoice number, such as INV-1057.' },
                { name: 'amount', description: 'The amount paid.' },
              ],
            },
          ],
        }),
        models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' },
      },
      compiler: { rateLimit: { per_second: 200, concurrency: 4, burst: 200 }, waitMs: 5_000 },
    },
  });
});
afterEach(async () => {
  await engine.builds.idle();
  await engine.close();
  await handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const payments = async () => (await (await fetch(`${fixture.url}/__fixture/payments`)).json()) as Payment[];

/** Recording a payment once, as `tooldrop record` saves it: the submit, then the confirmation marked. */
const recording = (url: string, withTarget = true): Recording => ({
  version: 1,
  recorder: 'cli',
  recorded_at: Date.now(),
  task: 'Record a payment for an invoice',
  actions: [
    { kind: 'goto', url: `${url}/payments/new` },
    {
      kind: 'fill',
      target: [{ kind: 'role', role: 'textbox', name: 'Invoice number' }],
      label: 'textbox "Invoice number"',
      value: 'INV-1057',
    },
    {
      kind: 'fill',
      target: [{ kind: 'role', role: 'spinbutton', name: 'Amount' }],
      label: 'spinbutton "Amount"',
      value: '100',
    },
    {
      kind: 'click',
      target: [{ kind: 'role', role: 'button', name: 'Record payment' }],
      label: 'button "Record payment"',
    },
  ],
  inputs: [
    { name: 'invoice', action: 1, example: 'INV-1057' },
    { name: 'amount', action: 2, example: '100' },
  ],
  ...(withTarget && { target: { selector: [{ kind: 'css', value: '#confirmation' }], label: 'status' } }),
});

async function finished(id: string): Promise<JobView> {
  for (let i = 0; i < 600; i++) {
    const job = await engine.getJob(id);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

describe('write builds', () => {
  it('builds a write tool from a recorded submission without submitting, then writes once approved', async () => {
    const { id: recordingId } = engine.saveRecording(recording(fixture.url));
    const job = await finished(
      (
        await engine.startBuild({
          url: `${fixture.url}/payments/new`,
          task: 'Record a payment for an invoice',
          authority: 'write',
          recording_id: recordingId,
        })
      ).id,
    );
    expect(job.error).toBeNull();
    expect(job.result).toMatchObject({ tool: 'record_invoice_payment', strategy: 'browser_script' });
    // The build previewed the form; it never submitted it.
    expect(await payments()).toEqual([]);

    const tool = await engine.getTool('record_invoice_payment');
    expect(tool.authority).toBe('write');
    expect(tool.input_schema).toMatchObject({
      properties: {
        invoice: { type: 'string' },
        amount: { type: 'number', description: 'The amount paid.' },
      },
      required: ['invoice', 'amount'],
    });
    expect(tool.recipe.steps.filter((step) => 'commit' in step && step.commit)).toHaveLength(1);
    expect(tool.recipe.steps.at(-1)).toMatchObject({ op: 'extract_text' });

    // Safe mode: a call previews and waits; approving makes the write.
    const asked = await engine
      .runTool('record_invoice_payment', { invoice: 'INV-1055', amount: 75 })
      .catch((error: unknown) => error);
    expect(asked).toMatchObject({ code: 'approval_required' });
    const approvalId = (asked as { details: { approval_id: string } }).details.approval_id;
    const decided = await engine.decideApproval(approvalId, 'approve');
    expect(decided.result).toContain('INV-1055 is paid, 75.00 USD');
    expect(await payments()).toMatchObject([{ invoice: 'INV-1055', amount: 75 }]);
  }, 120_000);

  it('builds writes only from recordings that submit and mark the confirmation', async () => {
    await expect(
      engine.startBuild({ url: `${fixture.url}/payments/new`, task: 'Record a payment', authority: 'write' }),
    ).rejects.toThrow('a write tool is built from a recording');

    const { id: recordingId } = engine.saveRecording(recording(fixture.url, false));
    const job = await finished(
      (
        await engine.startBuild({
          url: `${fixture.url}/payments/new`,
          task: 'Record a payment',
          authority: 'write',
          recording_id: recordingId,
        })
      ).id,
    );
    expect(job.error?.message).toContain('mark the confirmation the site shows after the submit');
    expect(await payments()).toEqual([]);
  }, 60_000);
});

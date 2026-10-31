import { fileURLToPath } from 'node:url';
import { memoryKeyStore } from '@tooldrop/auth';
import type { DatabaseHandle } from '@tooldrop/db';
import { openTestDatabase } from '@tooldrop/db/testing';
import { startHtmlAppFixture, type Payment } from '@tooldrop/fixture-html-app';
import { startJsonApiFixture } from '@tooldrop/fixture-json-api';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { Runtime } from '@tooldrop/runtime';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobView } from './builds.ts';
import { Engine } from './engine.ts';
import { readToolFile } from './tool-files.ts';

// SPEC's multi-site workflows: tools on two sites chained into one. The
// newest overdue invoice comes from the JSON API fixture's tool, and its
// payment is recorded on the HTML fixture, a write that waits for approval.

const recipe = (file: string) =>
  readToolFile(fileURLToPath(new URL(`../../../fixtures/recipes/${file}`, import.meta.url)));

let api: RunningFixture;
let html: RunningFixture;
let handle: DatabaseHandle;
let engine: Engine;

beforeAll(async () => {
  api = await startJsonApiFixture();
  html = await startHtmlAppFixture();
});
afterAll(async () => {
  await api.close();
  await html.close();
});
beforeEach(async () => {
  await fetch(`${html.url}/__fixture/reset`, { method: 'POST' });
  handle = await openTestDatabase();
  engine = new Engine({
    db: handle.db,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    backgroundHeals: false,
  });
  await engine.publish(recipe('json-api.list_invoices.json'), api.url);
  await engine.publish(recipe('html-app.record_payment.json'), html.url);
  await engine.publish(recipe('html-app.search_invoices.json'), html.url);
});
afterEach(async () => {
  await engine.workflows.idle();
  await engine.close();
  await handle.close();
});

const payments = async () => (await (await fetch(`${html.url}/__fixture/payments`)).json()) as Payment[];

const payOverdue = {
  name: 'pay_newest_overdue',
  description: 'Pay the newest overdue invoice from the invoices API in the payments portal.',
  input_schema: {
    type: 'object',
    properties: { amount: { type: 'number', exclusiveMinimum: 0 } },
    required: ['amount'],
  },
  steps: [
    { id: 'find', tool: 'list_invoices', inputs: { status: 'overdue' } },
    {
      id: 'pay',
      tool: 'record_payment',
      inputs: { invoice: '{{steps.find.result.0.number}}', amount: '{{input.amount}}' },
    },
  ],
  output: { invoice: '{{steps.find.result.0.number}}', confirmation: '{{steps.pay.result}}' },
};

/** Follows a run, answering each approval question with `answer`; undefined leaves it waiting. */
async function finish(id: string, answer?: 'approve' | 'reject'): Promise<JobView> {
  for (let i = 0; i < 900; i++) {
    const job = await engine.getJob(id);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    const open = job.questions.find((question) => question.answer === undefined);
    if (job.status === 'waiting_for_answer' && open && answer) {
      await engine.answerQuestion(id, open.id, answer);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${id} did not finish`);
}

describe('multi-site workflows', () => {
  it('chains a read on one site into a write on another, once the write is approved', async () => {
    const workflow = await engine.saveWorkflow(payOverdue);
    expect(workflow).toMatchObject({ name: 'pay_newest_overdue', authority: 'write' });

    const started = await engine.runWorkflow('pay_newest_overdue', { amount: 120 });
    // The write waits for approval, which the job asks for, with the values filled in.
    let job = started;
    for (let i = 0; i < 300 && job.status !== 'waiting_for_answer'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await engine.getJob(started.id);
    }
    expect(job.questions[0]?.text).toMatch(/record_payment, which changes the site: .*Amount = 120/);
    expect(await payments()).toEqual([]);

    const done = await finish(started.id, 'approve');
    expect(done.error).toBeNull();
    const { output, steps } = done.result as {
      output: { invoice: string; confirmation: string };
      steps: unknown[];
    };
    expect(output.invoice).toMatch(/^INV-\d+$/);
    expect(output.confirmation).toContain(`${output.invoice} is paid, 120.00 USD`);
    expect(steps).toMatchObject([
      { id: 'find', ok: true, attempts: 1 },
      { id: 'pay', ok: true, attempts: 1 },
    ]);
    expect(await payments()).toMatchObject([{ invoice: output.invoice, amount: 120 }]);
    // The write's approval is in the audit log, decided by the run.
    expect(await engine.listApprovals()).toMatchObject([
      { status: 'approved', decided_by: `job:${started.id}` },
    ]);
  }, 120_000);

  it('runs without asking when a policy approves the write, and stops when one is rejected', async () => {
    await engine.saveWorkflow(payOverdue);
    await engine.createPolicy({ tool: 'record_payment', field: 'amount', op: '<', value: 100 });
    const small = await finish((await engine.runWorkflow('pay_newest_overdue', { amount: 40 })).id);
    expect(small.status).toBe('succeeded');
    expect(small.questions).toEqual([]);

    const large = await finish(
      (await engine.runWorkflow('pay_newest_overdue', { amount: 400 })).id,
      'reject',
    );
    expect(large.status).toBe('failed');
    expect(large.error?.message).toContain(
      'step pay (record_payment) failed: the write of record_payment was rejected',
    );
    expect(await payments()).toHaveLength(1);
  }, 120_000);

  it('retries a failing step, then undoes the steps done, newest first', async () => {
    // A tool for a site that does not answer: it fails every time.
    await engine.publish(
      { ...recipe('json-api.list_invoices.json'), name: 'list_elsewhere' },
      'http://127.0.0.1:9',
    );
    await engine.createPolicy({ tool: 'record_payment', field: 'amount', op: '<', value: 100 });
    await engine.saveWorkflow({
      name: 'pay_then_check',
      description: 'Pay an invoice, then check another site, undoing the payment check if that fails.',
      input_schema: { type: 'object', properties: {} },
      steps: [
        {
          id: 'pay',
          tool: 'record_payment',
          inputs: { invoice: 'INV-1057', amount: 10 },
          compensate: { tool: 'search_invoices', inputs: { status: 'paid' } },
        },
        { id: 'check', tool: 'list_elsewhere', inputs: { status: 'open' }, retries: 1 },
      ],
    });
    const job = await finish((await engine.runWorkflow('pay_then_check', {})).id);
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/^step check \(list_elsewhere\) failed: /);
    expect(job.error?.message).toMatch(/Undone: pay\.$/);
    expect(job.error?.details).toMatchObject({
      steps: [
        { id: 'pay', ok: true },
        { id: 'check', ok: false, attempts: 2 },
      ],
      compensations: [{ id: 'pay', tool: 'search_invoices', ok: true }],
    });
  }, 120_000);

  it('checks workflows before saving them, and their inputs before running them', async () => {
    await expect(
      engine.saveWorkflow({ ...payOverdue, output: undefined, steps: [{ id: 'x', tool: 'no_such_tool' }] }),
    ).rejects.toThrow('step x calls no_such_tool, which is not a published tool');
    await expect(
      engine.saveWorkflow({
        ...payOverdue,
        output: undefined,
        steps: [{ id: 'pay', tool: 'record_payment', inputs: { invoice: '{{steps.later.result}}' } }],
      }),
    ).rejects.toThrow('uses step later, which does not come before it');
    await expect(engine.saveWorkflow({ ...payOverdue, name: 'list_invoices' })).rejects.toThrow(
      'a tool is named',
    );
    await expect(engine.saveWorkflow(payOverdue, ['pay_newest_overdue'])).rejects.toThrow('scope "*"');

    await engine.saveWorkflow(payOverdue);
    await expect(engine.runWorkflow('pay_newest_overdue', {})).rejects.toThrow(
      "must have required property 'amount'",
    );
    await expect(engine.runWorkflow('pay_newest_overdue', { amount: 1 }, ['list_invoices'])).rejects.toThrow(
      'no workflow pay_newest_overdue',
    );
    await expect(
      engine.publish({ ...recipe('json-api.list_invoices.json'), name: 'pay_newest_overdue' }, api.url),
    ).rejects.toThrow('a workflow is named');
    await engine.deleteWorkflow('pay_newest_overdue');
    expect(await engine.listWorkflows()).toEqual([]);
  }, 60_000);
});

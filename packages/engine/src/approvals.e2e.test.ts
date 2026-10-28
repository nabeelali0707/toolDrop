import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryKeyStore } from '@tooldrop/auth';
import { isToolDropError, type WritePreview } from '@tooldrop/core';
import { approvals, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { startHtmlAppFixture, type Payment } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { Runtime } from '@tooldrop/runtime';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from './engine.ts';
import { readToolFile } from './tool-files.ts';

// SPEC's Safe mode criterion: a write tool never submits without an
// approval, and a rejected preview leaves the fixture unchanged. The write
// is the HTML fixture's payment form.

const recordPayment = readToolFile(
  fileURLToPath(new URL('../../../fixtures/recipes/html-app.record_payment.json', import.meta.url)),
);

let fixture: RunningFixture;
let dataDir: string;
let handle: DatabaseHandle;
let engine: Engine;

beforeAll(async () => {
  fixture = await startHtmlAppFixture();
});
afterAll(() => fixture.close());

beforeEach(async () => {
  await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST' });
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-approvals-'));
  handle = openDatabase(join(dataDir, 'tooldrop.db'));
  runMigrations(handle.db);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
  });
  engine.publish(recordPayment, fixture.url);
});
afterEach(async () => {
  await engine.close();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const payments = async () => (await (await fetch(`${fixture.url}/__fixture/payments`)).json()) as Payment[];

/** Calls a write tool and returns the approval it asks for. */
async function askToPay(invoice: string, amount: number) {
  try {
    await engine.runTool('record_payment', { invoice, amount });
  } catch (error) {
    if (isToolDropError(error) && error.code === 'approval_required') {
      return error.details as { approval_id: string; preview: WritePreview };
    }
    throw error;
  }
  throw new Error('the write did not wait for an approval');
}

const isPng = (data: Buffer | undefined) => data?.subarray(1, 4).toString() === 'PNG';

describe('safe mode', () => {
  it('previews a write, changes nothing until it is approved, and makes it once', async () => {
    const { approval_id: id, preview } = await askToPay('INV-1057', 100);
    expect(preview).toEqual({
      url: `${fixture.url}/payments/new`,
      action: 'click role=button[name="Record payment"] | css=button[type=submit]',
      fields: [
        { field: 'Invoice number', value: 'INV-1057' },
        { field: 'Amount', value: '100' },
      ],
    });
    expect(isPng(engine.approvalScreenshot(id, 'before'))).toBe(true);
    expect(await payments()).toEqual([]);
    expect(engine.listApprovals(['*'], 'pending').map((approval) => approval.id)).toEqual([id]);

    const decided = await engine.decideApproval(id, 'approve', ['*'], 'test');
    expect(decided.result).toBe('Payment PAY-0001 recorded: INV-1057 is paid, 100.00 USD.');
    expect(decided.meta).toMatchObject({ approval_id: id, strategy: 'browser_script' });
    expect(decided.approval).toMatchObject({
      status: 'approved',
      decided_by: 'test',
      screenshots: { before: true, after: true },
      outcome: { ok: true, url: `${fixture.url}/payments/PAY-0001` },
    });
    expect(isPng(engine.approvalScreenshot(id, 'after'))).toBe(true);
    expect(await payments()).toEqual([{ id: 'PAY-0001', invoice: 'INV-1057', amount: 100, reference: '' }]);

    // An approval is used once.
    await expect(engine.decideApproval(id, 'approve')).rejects.toMatchObject({ code: 'conflict' });
    expect(await payments()).toHaveLength(1);
  }, 60_000);

  it('leaves the site unchanged when the preview is rejected', async () => {
    const { approval_id: id } = await askToPay('INV-1057', 100);
    const { approval } = await engine.decideApproval(id, 'reject', ['*'], 'test');
    expect(approval).toMatchObject({ status: 'rejected', decided_by: 'test', outcome: null });
    await expect(engine.decideApproval(id, 'approve')).rejects.toMatchObject({ code: 'conflict' });
    expect(await payments()).toEqual([]);
    const page = await (await fetch(`${fixture.url}/invoices?status=paid`)).text();
    expect(page).not.toContain('INV-1057');
  }, 60_000);

  it('shows a dry run without asking for an approval', async () => {
    const outcome = await engine.runTool('record_payment', {
      invoice: 'INV-1057',
      amount: 100,
      dry_run: true,
    });
    expect(outcome.meta).toMatchObject({ dry_run: true });
    expect(outcome.result).toMatchObject({ fields: [{ field: 'Invoice number', value: 'INV-1057' }, {}] });
    expect(isPng(outcome.screenshot)).toBe(true);
    expect(engine.listApprovals()).toEqual([]);
    expect(await payments()).toEqual([]);
  }, 60_000);

  it('lets a policy approve small payments, while larger ones still wait', async () => {
    const policy = engine.createPolicy({ tool: 'record_payment', field: 'amount', op: '<', value: 100 });
    const small = await engine.runTool('record_payment', { invoice: 'INV-1057', amount: 40 });
    expect(small.result).toContain('INV-1057 is paid');
    expect(engine.listApprovals()[0]).toMatchObject({
      decided_by: `policy:${policy.id}`,
      status: 'approved',
    });

    await askToPay('INV-1056', 150);
    expect(await payments()).toHaveLength(1);

    expect(() =>
      engine.createPolicy({ tool: 'record_payment', field: 'amount', op: '<', value: 1 }, ['x']),
    ).toThrow('scope "*"');
    expect(() =>
      engine.createPolicy({ tool: 'record_payment', field: 'amount', op: '<', value: 'x' }),
    ).toThrow('needs a number');
    engine.deletePolicy(policy.id);
    expect(engine.listPolicies()).toEqual([]);
  }, 60_000);

  it('refuses an approval that is too old, or for a tool that changed since', async () => {
    const old = await askToPay('INV-1057', 100);
    handle.db
      .update(approvals)
      .set({ expires_at: new Date(Date.now() - 1) })
      .where(eq(approvals.id, old.approval_id))
      .run();
    await expect(engine.decideApproval(old.approval_id, 'approve')).rejects.toThrow('more than 24 hours old');

    const changed = await askToPay('INV-1057', 100);
    engine.publish(recordPayment, fixture.url);
    await expect(engine.decideApproval(changed.approval_id, 'approve')).rejects.toThrow(
      'changed since this preview',
    );
    expect(engine.getApproval(changed.approval_id)).toMatchObject({
      status: 'rejected',
      decided_by: 'outdated',
    });
    expect(await payments()).toEqual([]);
  }, 60_000);

  it('says when a write was submitted but its result could not be read', async () => {
    // INV-1056 is already paid, so the site refuses the payment after the submit.
    const { approval_id: id } = await askToPay('INV-1056', 100);
    await expect(engine.decideApproval(id, 'approve')).rejects.toMatchObject({
      code: 'strategy_failed',
      details: { approval_id: id, committed: true },
    });
    const approval = engine.getApproval(id);
    expect(approval.outcome).toMatchObject({ ok: false, url: `${fixture.url}/payments` });
    expect(approval.outcome?.error?.message).toContain('no element matches css=#confirmation');
    expect(await payments()).toEqual([]);
  }, 60_000);

  it('keeps write tools out of the health check and away from other keys', async () => {
    expect(await engine.healthCheck()).toEqual([]);
    const { approval_id: id } = await askToPay('INV-1057', 100);
    expect(() => engine.getApproval(id, ['list_invoices'])).toThrow(`no approval ${id}`);
    expect(engine.listApprovals(['list_invoices'])).toEqual([]);
  }, 60_000);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryKeyStore } from '@tooldrop/auth';
import { createApiKey, openDatabase, runMigrations, type DatabaseHandle } from '@tooldrop/db';
import { Engine, readToolFile } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { Runtime } from '@tooldrop/runtime';
import { createServer } from '@tooldrop/server';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The dashboard smoke test (PLAN, Phase 4 gate): the static export, served
// by toolDrop's own server, signs in with a key and shows tools, runs,
// approvals, logins and questions, and approving a write from the page
// makes it.

const app = fileURLToPath(new URL('..', import.meta.url));
const recipe = (file: string) =>
  readToolFile(fileURLToPath(new URL(`../../../fixtures/recipes/${file}`, import.meta.url)));

let dataDir: string;
let handle: DatabaseHandle;
let fixture: RunningFixture;
let engine: Engine;
let server: ReturnType<typeof createServer>;
let base: string;
let key: string;
let browser: Browser;

beforeAll(async () => {
  // Always a fresh export: a stale one would test old pages.
  const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
  execFileSync(process.execPath, [next, 'build'], { cwd: app, stdio: 'ignore' });
  fixture = await startHtmlAppFixture();
  dataDir = mkdtempSync(join(tmpdir(), 'tooldrop-dashboard-'));
  handle = openDatabase(join(dataDir, 'tooldrop.db'));
  await runMigrations(handle.db);
  engine = new Engine({
    db: handle.db,
    dataDir,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
  });
  await engine.publish(recipe('html-app.search_invoices.json'), fixture.url);
  await engine.publish(recipe('html-app.record_payment.json'), fixture.url);
  await engine.runTool('search_invoices', { status: 'paid' });
  await engine.runTool('record_payment', { invoice: 'INV-1057', amount: 100 }).catch(() => undefined);
  server = createServer({ engine, dashboardDir: join(app, 'out') });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  key = (await createApiKey(handle.db, { label: 'dashboard' })).key;
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  await engine.close();
  await handle.close();
  await fixture.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

async function openPage(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/`);
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Open the dashboard' }).click();
  await page.getByRole('heading', { name: 'Tools' }).waitFor();
  return { page, errors };
}

describe('the dashboard', () => {
  it('shows tools, their schema and cURL, runs, logins and questions', async () => {
    const { page, errors } = await openPage();
    await page.getByRole('link', { name: 'search_invoices' }).click();
    await page.getByRole('heading', { name: 'search_invoices' }).waitFor();
    expect(await page.getByTestId('curl').textContent()).toContain(`${base}/v1/tools/search_invoices/run`);
    await page.getByText('current').first().waitFor();

    await page.getByRole('link', { name: 'Runs' }).click();
    await page.getByRole('heading', { name: 'Runs' }).waitFor();
    await page.getByRole('cell', { name: 'search_invoices' }).first().waitFor();

    await page.getByRole('link', { name: 'Logins' }).click();
    // A site of its own: a saved login makes every call to its site sign in first.
    await page.getByLabel('Site').fill('https://shop.example.test');
    await page.getByLabel('Username').fill('fixture-user');
    await page.getByLabel('Password').fill('fixture-password-not-real');
    await page.getByRole('button', { name: 'Save login' }).click();
    await page.getByText('Saved, encrypted in the vault.').waitFor();
    // The label defaults to the masked username too, so look for the username itself.
    await page.locator('code', { hasText: 'fi••••er' }).waitFor();
    expect(await page.content()).not.toContain('fixture-password-not-real');

    await page.getByRole('link', { name: 'Questions and repairs' }).click();
    await page.getByText('Nothing is waiting for an answer.').waitFor();
    expect(errors).toEqual([]);
  }, 120_000);

  it('shows a waiting write with its screenshot, and approving it makes the write', async () => {
    const { page, errors } = await openPage();
    await page.getByRole('link', { name: 'Approvals' }).click();
    const card = page.getByTestId('pending-approval');
    await card.getByText('INV-1057').waitFor();
    await card.getByRole('img', { name: 'The filled form, before the write' }).waitFor();
    await card.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('No write is waiting for approval.').waitFor();
    await page.getByRole('cell', { name: 'approved' }).waitFor();
    const payments = (await (await fetch(`${fixture.url}/__fixture/payments`)).json()) as unknown[];
    expect(payments).toHaveLength(1);
    expect(errors).toEqual([]);
  }, 120_000);
});

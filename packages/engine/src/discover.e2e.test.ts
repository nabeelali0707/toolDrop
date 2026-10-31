import { memoryKeyStore } from '@tooldrop/auth';
import type { DatabaseHandle } from '@tooldrop/db';
import { openTestDatabase } from '@tooldrop/db/testing';
import { DEMO_SHOP_ACCOUNT, startDemoShopFixture } from '@tooldrop/fixture-demo-shop';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FakeProvider, type ChatRequest } from '@tooldrop/llm';
import { Runtime } from '@tooldrop/runtime';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JobView } from './builds.ts';
import { Engine } from './engine.ts';

// URL-first discovery (SPEC, Differentiating features): from one URL, crawl
// the site and propose tools. The model is scripted; the crawl is real.

let browser: Browser;
let htmlApp: RunningFixture;
let shop: RunningFixture;
let handle: DatabaseHandle;
let engine: Engine | undefined;
let provider: FakeProvider;

const prompt = (request: ChatRequest) => request.messages.find((m) => m.role === 'user')?.content ?? '';

beforeAll(async () => {
  browser = await chromium.launch();
  htmlApp = await startHtmlAppFixture();
  shop = await startDemoShopFixture();
});
afterAll(async () => {
  await browser.close();
  await htmlApp.close();
  await shop.close();
});
afterEach(async () => {
  await engine?.builds.idle();
  await engine?.close();
  engine = undefined;
  await handle.close();
});

async function start(catalog: Record<string, unknown>): Promise<Engine> {
  handle = await openTestDatabase();
  provider = new FakeProvider({ discover: [catalog] });
  engine = new Engine({
    db: handle.db,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    builds: { models: { provider, models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' } }, browser },
  });
  return engine;
}

async function finished(discovering: Engine, id: string): Promise<JobView> {
  for (let i = 0; i < 600; i++) {
    const job = await discovering.getJob(id);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

describe('discovery', () => {
  it('crawls a site by its links, describes it without its data, and proposes tools on it', async () => {
    const discovering = await start({
      tools: [
        {
          name: 'search_invoices',
          description: 'Find invoices by status and issue date.',
          task: 'Search my invoices by status and date',
          url: '/invoices',
          authority: 'read',
          inputs: ['status', 'from'],
        },
        {
          name: 'record_payment',
          description: 'Record a payment against an invoice.',
          task: 'Record a payment for an invoice',
          url: '/payments/new',
          authority: 'write',
        },
        // Off the site, and a name already taken: both left out.
        {
          name: 'elsewhere',
          description: 'A page on another site.',
          task: 'Open another site entirely',
          url: 'https://example.test/x',
          authority: 'read',
        },
        {
          name: 'search_invoices',
          description: 'The same name again, once more.',
          task: 'Search invoices again please',
          url: '/invoices',
          authority: 'read',
        },
      ],
    });
    const job = await finished(discovering, (await discovering.startDiscover({ url: htmlApp.url })).id);
    expect(job.error).toBeNull();
    const result = job.result as {
      site: string;
      pages: { url: string }[];
      tools: { name: string; url: string }[];
    };
    expect(result.site).toBe(htmlApp.url);
    expect(result.pages.map((page) => page.url)).toEqual(
      expect.arrayContaining(['/invoices', '/payments/new']),
    );
    expect(result.tools).toEqual([
      expect.objectContaining({
        name: 'search_invoices',
        url: `${htmlApp.url}/invoices`,
        inputs: ['status', 'from'],
      }),
      expect.objectContaining({ name: 'record_payment', authority: 'write', inputs: [] }),
    ]);

    const notes = prompt(provider.requests[0]!);
    expect(notes).toContain('table: Number, Supplier, Date, Amount, Status');
    expect(notes).toMatch(
      /form GET \/invoices "Search": Status \[select status\] \(open, paid, overdue, draft\)/,
    );
    expect(notes).toMatch(/form POST \/payments "Record payment"/);
    // Structure only: no invoice from the table reaches the model.
    expect(notes).not.toContain('Acme Paper');
    expect(notes).not.toContain('INV-1057');
    // Links are followed; forms are never sent.
    expect(await (await fetch(`${htmlApp.url}/__fixture/payments`)).json()).toEqual([]);
  }, 120_000);

  it('crawls signed in, notes the JSON a page loads, and never signs out', async () => {
    const discovering = await start({
      tools: [
        {
          name: 'list_orders',
          description: 'List my orders with their status and delivery.',
          task: 'List my orders by status',
          url: '/account/orders',
          authority: 'read',
          inputs: ['status'],
        },
      ],
    });
    await discovering.addLogin({
      site: shop.url,
      username: DEMO_SHOP_ACCOUNT.username,
      password: DEMO_SHOP_ACCOUNT.password,
      totp_secret: DEMO_SHOP_ACCOUNT.totpSecret,
    });
    const job = await finished(discovering, (await discovering.startDiscover({ url: shop.url })).id);
    expect(job.error).toBeNull();
    expect((job.result as { pages: { url: string }[] }).pages.map((page) => page.url)).toContain(
      '/account/orders',
    );
    const notes = prompt(provider.requests[0]!);
    expect(notes).toMatch(/loads JSON: GET \/api\/v1\/orders → \{ data: \[\{ orderId: string/);
    // Keys and types only: the session token the page fetched is not in the notes.
    expect(notes).toMatch(/GET \/api\/session\/token → \{ token: string/);
    expect(notes).not.toContain(DEMO_SHOP_ACCOUNT.password);
    // Still signed in afterwards: the crawl never sent the sign-out form.
    expect(await discovering.signIn(shop.url)).toBe(true);
  }, 180_000);

  it('checks the request and the caller', async () => {
    const discovering = await start({ tools: [] });
    await expect(discovering.startDiscover({ url: 'ftp://x' })).rejects.toThrow(/invalid discover request/);
    await expect(discovering.startDiscover({ url: htmlApp.url }, ['list_orders'])).rejects.toThrow(/scope/);
  });
});

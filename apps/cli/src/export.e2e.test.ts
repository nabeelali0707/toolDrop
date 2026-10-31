import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { memoryKeyStore } from '@tooldrop/auth';
import { toolFileSchema } from '@tooldrop/core';
import type { DatabaseHandle } from '@tooldrop/db';
import { openTestDatabase } from '@tooldrop/db/testing';
import { Engine, readToolFile } from '@tooldrop/engine';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import { Runtime } from '@tooldrop/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExportRuntime } from './export-runtime.ts';

// SPEC's Code export: a tool exported as a package runs without toolDrop.
// Each package is written under apps/cli, so its imports resolve to the npm
// packages this workspace installed, as `npm install` would provide them, and
// is run in a Node.js process of its own.

const cli = fileURLToPath(new URL('..', import.meta.url));
const recipe = (file: string) =>
  readToolFile(fileURLToPath(new URL(`../../../fixtures/recipes/${file}`, import.meta.url)));
const run = promisify(execFile);

let htmlApp: RunningFixture;
let login: RunningFixture;
let handle: DatabaseHandle;
let engine: Engine;
let root: string;

beforeAll(async () => {
  htmlApp = await startHtmlAppFixture();
  login = await startLoginTotpFixture();
  handle = await openTestDatabase();
  engine = new Engine({
    db: handle.db,
    runtime: new Runtime({ browserWaitMs: 5_000 }),
    keyStore: () => Promise.resolve(memoryKeyStore()),
    exportRuntime: loadExportRuntime,
  });
  root = mkdtempSync(join(cli, '.export-test-'));
}, 120_000);

afterAll(async () => {
  await engine.close();
  await handle.close();
  await htmlApp.close();
  await login.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** Exports a tool into its own folder and returns the folder. */
async function exported(name: string): Promise<string> {
  const files = await engine.exportTool(name);
  const folder = join(root, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  return folder;
}

/** Runs a script against the package in a process of its own, and returns what it printed as JSON. */
async function inPackage(folder: string, script: string, env: Record<string, string> = {}): Promise<unknown> {
  writeFileSync(join(folder, 'check.mjs'), script);
  const { stdout } = await run(process.execPath, ['check.mjs'], {
    cwd: folder,
    env: { ...process.env, ...env },
    timeout: 90_000,
  });
  return JSON.parse(stdout) as unknown;
}

describe('code export', () => {
  it('exports a read tool that runs on its own, typed and documented', async () => {
    await engine.publish(recipe('html-app.search_invoices.json'), htmlApp.url);
    const folder = await exported('search_invoices');
    const packageJson = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Third-party packages only: nothing of toolDrop is a dependency.
    expect(Object.keys(packageJson.dependencies).some((name) => name.startsWith('@tooldrop'))).toBe(false);
    expect(readFileSync(join(folder, 'index.d.ts'), 'utf8')).toContain(
      'status?: "open" | "paid" | "overdue" | "draft";',
    );
    expect(readFileSync(join(folder, 'runtime.js'), 'utf8')).not.toMatch(/from ['"]@tooldrop\//);

    const rows = (await inPackage(
      folder,
      `import { search_invoices } from './index.js';
console.log(JSON.stringify(await search_invoices({ status: 'paid' })));`,
    )) as { status: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === 'paid')).toBe(true);
  }, 120_000);

  it('exports a write tool as preview and commit, and submits only on commit', async () => {
    await fetch(`${htmlApp.url}/__fixture/reset`, { method: 'POST' });
    await engine.publish(recipe('html-app.record_payment.json'), htmlApp.url);
    const folder = await exported('record_payment');
    const payments = async () =>
      (await (await fetch(`${htmlApp.url}/__fixture/payments`)).json()) as unknown[];

    const preview = (await inPackage(
      folder,
      `import { preview } from './index.js';
const { preview: shown, screenshot } = await preview({ invoice: 'INV-1057', amount: 100 });
console.log(JSON.stringify({ shown, screenshot: screenshot !== undefined }));`,
    )) as { shown: { fields: { field: string; value: string }[] }; screenshot: boolean };
    expect(preview.shown.fields).toContainEqual({ field: 'Amount', value: '100' });
    expect(preview.screenshot).toBe(true);
    expect(await payments()).toEqual([]);

    const result = await inPackage(
      folder,
      `import { commit } from './index.js';
console.log(JSON.stringify(await commit({ invoice: 'INV-1057', amount: 100 })));`,
    );
    expect(result).toContain('INV-1057 is paid');
    expect(await payments()).toHaveLength(1);
  }, 120_000);

  it('exports a signed-in tool with the steps that sign in, and signs in with the login it is given', async () => {
    await engine.addLogin({
      site: login.url,
      username: FIXTURE_ACCOUNT.username,
      password: FIXTURE_ACCOUNT.password,
      totp_secret: FIXTURE_ACCOUNT.totpSecret,
    });
    await engine.publish(
      toolFileSchema.parse({
        name: 'protected_invoices',
        description: 'The newest invoices on the signed-in page.',
        authority: 'read',
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'array' },
        recipe: {
          strategy: 'html_fetch',
          steps: [
            { op: 'http', method: 'GET', url: '{{site}}/invoices' },
            {
              op: 'extract_table',
              target: [{ kind: 'test_id', value: 'invoices' }],
              columns: { number: 'Number' },
            },
          ],
        },
      }),
      login.url,
    );
    // The login recipe exists once toolDrop has signed in.
    await expect(engine.exportTool('protected_invoices')).rejects.toThrow('logins verify');
    expect(await engine.signIn(login.url)).toBe(true);
    const folder = await exported('protected_invoices');
    for (const file of ['tool.json', 'index.js', 'runtime.js', 'README.md']) {
      const text = readFileSync(join(folder, file), 'utf8');
      expect(text).not.toContain(FIXTURE_ACCOUNT.password);
      expect(text).not.toContain(FIXTURE_ACCOUNT.totpSecret);
    }

    const script = `import { protected_invoices } from './index.js';
try {
  const login = process.env.SITE_USERNAME
    ? { username: process.env.SITE_USERNAME, password: process.env.SITE_PASSWORD, totp_secret: process.env.SITE_TOTP }
    : undefined;
  console.log(JSON.stringify(await protected_invoices({}, login ? { login } : {})));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}`;
    expect(await inPackage(folder, script)).toMatchObject({
      error: expect.stringContaining('needs a login') as string,
    });
    const rows = await inPackage(folder, script, {
      SITE_USERNAME: FIXTURE_ACCOUNT.username,
      SITE_PASSWORD: FIXTURE_ACCOUNT.password,
      SITE_TOTP: FIXTURE_ACCOUNT.totpSecret,
    });
    expect(rows).toHaveLength(10);
  }, 180_000);
});

// SPEC's Zero cost criterion: on a clean machine with no API keys or paid
// accounts, `docker compose up` builds and runs a fixture tool end to end.
//
//   node scripts/zero-cost-e2e.ts
//
// It needs Docker and about 15 GB of disk: the image, Ollama and one 7B model,
// downloaded on first start. A build on a CPU takes a few minutes per model
// call, so CI runs this on demand and weekly (.github/workflows/zero-cost.yml),
// not on every change. Nothing here uses a key or an account.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHtmlAppFixture } from '../fixtures/html-app/src/server.ts';

const APP = 'http://127.0.0.1:3000';
/** The HTML fixture, as the app container reaches the host. */
const SITE = 'http://host.docker.internal:4102';
/** One model for both roles, so the check downloads one. */
const MODEL = 'qwen2.5-coder:7b';
const compose = ['compose', '-f', 'compose.yaml', '-f', 'scripts/zero-cost.compose.yaml'];
const env = { ...process.env, TOOLDROP_CODE_MODEL: MODEL, TOOLDROP_REASONING_MODEL: MODEL };

function docker(args: string[]): string {
  return execFileSync('docker', [...compose, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function step(text: string): void {
  console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${text}`);
}

async function until<T>(what: string, minutes: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${minutes} minutes waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

const fixture = createHtmlAppFixture();
// On all addresses, so the app container reaches it through the Docker host.
await fixture.listen({ host: '0.0.0.0', port: 4102 });
let failed = false;
try {
  step(`docker compose up --build, with ${MODEL} for both roles`);
  docker(['up', '--detach', '--build']);

  step('waiting for the model download and for toolDrop');
  docker(['wait', 'models']);
  await until('toolDrop to answer /health', 5, async () =>
    (await fetch(`${APP}/health`)).ok ? true : undefined,
  );
  const key = /td_[A-Za-z0-9_-]+/.exec(docker(['logs', 'app']))?.[0];
  if (!key) throw new Error('the app printed no first API key');
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${APP}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const answer = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(answer)}`);
    return answer;
  };

  step('uploading a recording of the task, done once on the fixture');
  const { id: recording } = (await call('POST', '/v1/recordings', {
    version: 1,
    recorder: 'cli',
    recorded_at: Date.now(),
    task: 'List my invoices, filtered by status',
    actions: [
      { kind: 'goto', url: `${SITE}/invoices` },
      {
        kind: 'select',
        target: [{ kind: 'css', value: 'select[name="status"]' }],
        label: 'combobox "Status"',
        value: 'paid',
        options: ['', 'open', 'paid', 'overdue', 'draft'].map((value) => ({ value, label: value || 'All' })),
      },
      { kind: 'click', target: [{ kind: 'test_id', value: 'search' }], label: 'button "Search"' },
    ],
    inputs: [{ name: 'status', action: 1, example: 'paid' }],
    target: { selector: [{ kind: 'test_id', value: 'invoices' }] },
  })) as { id: string };

  step('building the tool with the local model');
  const { job } = (await call('POST', '/v1/builds', {
    url: `${SITE}/invoices`,
    task: 'List my invoices, filtered by status',
    authority: 'read',
    recording_id: recording,
  })) as { job: { id: string } };
  let last = '';
  const result = await until('the build', 90, async () => {
    const { job: now } = (await call('GET', `/v1/jobs/${job.id}`)) as {
      job: {
        status: string;
        step: string | null;
        result?: { tool: string };
        error?: { message: string } | null;
      };
    };
    const line = `${now.status} ${now.step ?? ''}`;
    if (line !== last) console.log(`  ${line}`);
    last = line;
    if (now.status === 'failed') throw new Error(`the build failed: ${now.error?.message}`);
    return now.status === 'succeeded' ? now.result : undefined;
  });
  if (!result) throw new Error('the build ended without a tool');

  step(`running ${result.tool}`);
  const started = Date.now();
  const run = (await call('POST', `/v1/tools/${result.tool}/run`, { status: 'overdue' })) as {
    result: { status?: string }[];
  };
  const rows = run.result;
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => row.status !== 'overdue')) {
    throw new Error(`the tool answered something else: ${JSON.stringify(run).slice(0, 500)}`);
  }
  console.log(`  ${rows.length} overdue invoices in ${Date.now() - started} ms`);
  console.log('\nZero cost: passed. No API key or paid account was used.');
} catch (error) {
  failed = true;
  console.error(`\nZero cost: failed. ${error instanceof Error ? error.message : String(error)}`);
  spawnSync('docker', [...compose, 'logs', '--tail', '80', 'app'], { env, stdio: 'inherit' });
} finally {
  if (!process.env.KEEP_STACK) docker(['down', '--volumes']);
  await fixture.close();
}
process.exitCode = failed ? 1 : 0;

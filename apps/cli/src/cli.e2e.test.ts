import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { ollamaUrl } from '@tooldrop/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recommendedModels } from './commands/init.ts';

const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

let home: string;
let fixture: RunningFixture;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tooldrop-cli-'));
  fixture = await startHtmlAppFixture();
});

afterEach(async () => {
  await fixture.close();
  // Windows can hold a just-closed database file for a moment.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * Runs the CLI as a user would, with its own data folder. Asynchronous on
 * purpose: the fixture sites run in this process and must keep answering.
 */
function cli(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return cliWithInput(undefined, ...args);
}

/** The same, with text piped into the command, as `--password-stdin` reads it. */
function cliWithInput(
  input: string | undefined,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A key file in the test's folder keeps tests away from the machine's real keychain.
    const env = { ...process.env, TOOLDROP_HOME: home, TOOLDROP_KEY_FILE: join(home, 'master.key') };
    const child = spawn(process.execPath, [main, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** What a well-behaved model answers to each of toolDrop's prompts, for the stand-in model servers. */
function answerLikeAModel(system: string, user: string): unknown {
  if (system.startsWith('You write toolDrop recipes')) {
    return JSON.parse(user.split('\n').find((line) => line.startsWith('{"strategy"')) ?? '{}') as unknown;
  }
  if (system.startsWith('You name and describe tools')) {
    return {
      name: 'list_invoices_by_status',
      description: 'The 10 newest invoices, optionally only those with a given status.',
      inputs: [{ name: 'status', description: 'Only invoices with this status.', required: false }],
      fields: [],
    };
  }
  return { questions: [] };
}

/** A recording of the HTML fixture's status filter, as a file `--recording` reads. */
function writeRecording(): string {
  const path = join(home, 'recording.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      recorder: 'cli',
      recorded_at: Date.now(),
      actions: [
        { kind: 'goto', url: `${fixture.url}/invoices` },
        {
          kind: 'select',
          target: [{ kind: 'css', value: 'select[name="status"]' }],
          label: 'combobox "Status"',
          value: 'overdue',
          options: ['', 'open', 'paid', 'overdue', 'draft'].map((value) => ({
            value,
            label: value || 'All',
          })),
        },
        { kind: 'click', target: [{ kind: 'test_id', value: 'search' }], label: 'button "Search"' },
      ],
      inputs: [{ name: 'status', action: 1, example: 'overdue' }],
      target: { selector: [{ kind: 'test_id', value: 'invoices' }] },
    }),
  );
  return path;
}

const addSearchInvoices = () =>
  cli('tools', 'add', repo('fixtures/recipes/html-app.search_invoices.json'), '--site', fixture.url);

describe('tooldrop CLI', { timeout: 120_000 }, () => {
  it('publishes a tool file and runs it', async () => {
    const added = await addSearchInvoices();
    expect(added.status).toBe(0);
    expect(added.stdout).toContain('Published search_invoices v1');
    expect((await cli('tools', 'list')).stdout).toContain('search_invoices  v1  read');

    const run = await cli('run', 'search_invoices', '--input', '{"status":"paid"}');
    expect(run.status).toBe(0);
    const { result, meta } = JSON.parse(run.stdout) as {
      result: { status: string }[];
      meta: { strategy: string };
    };
    expect(result.every((invoice) => invoice.status === 'paid')).toBe(true);
    expect(meta.strategy).toBe('html_fetch');
  });

  it('adds a community recipe folder with the site from its manifest', async () => {
    const added = await cli('tools', 'add', repo('recipes/hn.algolia.com/hn_front_page'));
    expect(added.stdout).toContain('Published hn_front_page v1 for https://hn.algolia.com');
  });

  it('reports errors on stderr with a non-zero exit', async () => {
    const missingSite = await cli('tools', 'add', repo('fixtures/recipes/html-app.search_invoices.json'));
    expect(missingSite.status).toBe(1);
    expect(missingSite.stderr).toContain('a tool file needs --site');
    expect((await cli('run', 'nope')).stderr).toContain('no tool named nope');
  });

  it('creates, lists and revokes API keys', async () => {
    const created = await cli('keys', 'create', '--label', 'laptop');
    expect(created.stdout).toMatch(/shown only this once:\s+td_[\w-]+/);
    const id = /^(\S+)\s+laptop/m.exec((await cli('keys', 'list')).stdout)?.[1] ?? '';
    expect((await cli('keys', 'revoke', id)).stdout).toContain(`Revoked ${id}`);
    expect((await cli('keys', 'list')).stdout).toContain('revoked');
  });

  it('builds a tool from a recording file, with a stand-in Ollama', async () => {
    // A stand-in for Ollama's chat API that answers like a model would.
    const ollama = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        return response.end(
          JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.1:8b' }] }),
        );
      }
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const { model, messages } = JSON.parse(body) as { model: string; messages: { content: string }[] };
        const [system = '', user = ''] = messages.map((message) => message.content);
        const reply = answerLikeAModel(system, user);
        response.end(
          JSON.stringify({
            model,
            message: { role: 'assistant', content: JSON.stringify(reply) },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 900,
            eval_count: 120,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    const address = ollama.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({
          llm: {
            provider: 'ollama',
            base_url: url,
            models: { code: 'qwen2.5-coder:7b', reasoning: 'llama3.1:8b' },
          },
        }),
      );
      const recordingFile = writeRecording();

      const built = await cli(
        'build',
        `${fixture.url}/invoices`,
        '--task',
        'Invoices by status',
        '--recording',
        recordingFile,
      );
      expect(built.stderr).toContain('... capturing');
      expect(built.status).toBe(0);
      expect(built.stdout).toContain('Built list_invoices_by_status (html_fetch, version 1) in 1 attempt.');
      expect(built.stdout).toContain('Model use: 3 calls, 2700 prompt and 360 completion tokens');

      const run = await cli('run', 'list_invoices_by_status', '--input', '{"status":"paid"}');
      expect(run.status).toBe(0);
      expect(
        (JSON.parse(run.stdout) as { result: { status: string }[] }).result.every(
          (row) => row.status === 'paid',
        ),
      ).toBe(true);
    } finally {
      ollama.close();
    }
  });

  it('saves a login sealed in the vault, and lists it masked', async () => {
    const password = 'fixture-password-not-real';
    await cli('init', '--yes', '--skip-browser', '--base-url', 'http://127.0.0.1:9');
    const added = await cliWithInput(
      `${password}\n`,
      'logins',
      'add',
      fixture.url,
      '--username',
      'fixture-user',
      '--password-stdin',
    );
    expect(added.stderr).toBe('');
    expect(added.status).toBe(0);
    expect(added.stdout).toContain(`Saved login fi••••er (fi••••er) for ${fixture.url}.`);

    const listed = await cli('logins', 'list');
    expect(listed.stdout).toContain(`${fixture.url}  fi••••er  fi••••er  no 2FA  unchecked`);
    // Neither the output nor the database file holds the password in plain text.
    for (const text of [
      added.stdout,
      listed.stdout,
      readFileSync(join(home, 'tooldrop.db')).toString('latin1'),
    ]) {
      expect(text).not.toContain(password);
    }
    const refused = await cli('logins', 'add', fixture.url, '--username', 'x');
    expect(refused.stderr).toContain('--password-stdin');
  });

  it('seals an endpoint API key in the vault, and sends it on model calls', async () => {
    const key = 'test-key-not-real-0123';
    // A stand-in OpenAI-compatible server that refuses calls without the key.
    const seen: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== `Bearer ${key}`) {
        response.statusCode = 401;
        return response.end(JSON.stringify({ error: 'bad key' }));
      }
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const { messages } = JSON.parse(body) as { messages: { content: string }[] };
        const [system = '', user = ''] = messages.map((message) => message.content);
        const content = JSON.stringify(answerLikeAModel(system, user));
        response.end(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 900, completion_tokens: 120 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
    try {
      const init = await cliWithInput(
        `${key}\n`,
        'init',
        '--yes',
        '--skip-browser',
        '--provider',
        'openai_compatible',
        '--base-url',
        url,
        '--code-model',
        'local-model',
        '--api-key-stdin',
      );
      expect(init.status).toBe(0);
      expect(init.stdout).toContain('The API key is sealed in the vault');
      const sealed = readFileSync(join(home, 'secrets', 'llm-api-key'));
      expect(sealed.toString('latin1')).not.toContain(key);
      expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain(key);

      const built = await cli(
        'build',
        `${fixture.url}/invoices`,
        '--task',
        'Invoices by status',
        '--recording',
        writeRecording(),
      );
      expect(built.stderr).not.toContain('The build failed');
      expect(built.status).toBe(0);
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen.every((header) => header === `Bearer ${key}`)).toBe(true);

      // Another endpoint never gets the key saved for this one.
      const other = `${url.slice(0, -'/v1'.length)}/other/v1`;
      const switched = await cli(
        'init',
        '--yes',
        '--skip-browser',
        '--provider',
        'openai_compatible',
        '--base-url',
        other,
        '--code-model',
        'local-model',
      );
      expect(switched.status).toBe(0);
      seen.length = 0;
      const refused = await cli(
        'build',
        `${fixture.url}/invoices`,
        '--task',
        'Invoices for the auditor',
        '--recording',
        writeRecording(),
      );
      expect(refused.status).not.toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((header) => header === undefined)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('records only in a terminal', async () => {
    const recorded = await cli('record', fixture.url);
    expect(recorded.status).toBe(1);
    expect(recorded.stderr).toContain('run it in a terminal');
  });

  it('serves MCP over stdio, as an MCP client starts it', async () => {
    await addSearchInvoices();
    const client = new Client({ name: 'stdio-client', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [main, 'mcp'],
        env: { ...(process.env as Record<string, string>), TOOLDROP_HOME: home },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('search_invoices');
    const response = await client.callTool({ name: 'search_invoices', arguments: { status: 'draft' } });
    expect(response.isError).toBeFalsy();
    await client.close();
  });

  it('serves REST with a first key, shown once', async () => {
    await addSearchInvoices();
    const port = 4300 + Math.floor(Math.random() * 500);
    const server = spawn(process.execPath, [main, 'serve', '--port', String(port)], {
      env: { ...process.env, TOOLDROP_HOME: home },
    });
    try {
      const output = await new Promise<string>((resolve, reject) => {
        let text = '';
        server.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes('is listening')) resolve(text);
        });
        server.once('exit', () => reject(new Error(`serve exited: ${text}`)));
      });
      const key = /(td_[\w-]+)/.exec(output)?.[1];
      const tools = await fetch(`http://127.0.0.1:${port}/v1/tools`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(((await tools.json()) as { tools: { name: string }[] }).tools[0]?.name).toBe('search_invoices');
    } finally {
      // Wait for the process to exit, so it lets go of the database file.
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
  });
});

describe('tooldrop init', { timeout: 60_000 }, () => {
  let ollama: Server;
  let pulled: string[];

  /** A stand-in for Ollama's API, so tests never download models. */
  const startOllama = async (installed: string[]) => {
    pulled = [];
    ollama = createServer((request, response) => {
      if (request.url === '/api/version') return response.end(JSON.stringify({ version: '0.30.10' }));
      if (request.url === '/api/tags')
        return response.end(JSON.stringify({ models: installed.map((name) => ({ name })) }));
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        pulled.push((JSON.parse(body) as { model: string }).model);
        response.end(
          ['{"status":"pulling"}', '{"total":10,"completed":10}', '{"status":"success"}'].join('\n'),
        );
      });
    });
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    const address = ollama.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  };

  afterEach(() => ollama?.close());

  it('recommends models by memory: 7B under 16 GB, 14B from 16 GB', () => {
    expect(recommendedModels(8 * 1024 ** 3).code).toBe('qwen2.5-coder:7b');
    expect(recommendedModels(15.7 * 1024 ** 3).code).toBe('qwen2.5-coder:14b'); // a "16 GB" machine
    expect(recommendedModels(32 * 1024 ** 3)).toEqual({
      code: 'qwen2.5-coder:14b',
      reasoning: 'llama3.1:8b',
    });
  });

  it("reads Ollama's address the way Ollama does", () => {
    expect(ollamaUrl(undefined)).toBe('http://127.0.0.1:11434');
    expect(ollamaUrl('0.0.0.0')).toBe('http://127.0.0.1:11434');
    expect(ollamaUrl('gpu-box:9000')).toBe('http://gpu-box:9000');
  });

  it('saves the models and downloads only the missing ones', async () => {
    const url = await startOllama(['llama3.1:8b']);
    const result = await cli('init', '--yes', '--skip-browser', '--base-url', url);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Found Ollama 0.30.10');
    expect(result.stdout).toContain("The vault's master key is in " + join(home, 'master.key'));
    expect(readFileSync(join(home, 'master.key'), 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      llm: { provider: string; models: { code: string; reasoning: string } };
    };
    expect(config.llm).toMatchObject({
      provider: 'ollama',
      base_url: url,
      models: { reasoning: 'llama3.1:8b' },
    });
    expect(pulled).toEqual([config.llm.models.code]);
  });

  it('explains how to install Ollama when it is not running', async () => {
    const result = await cli('init', '--yes', '--skip-browser', '--base-url', 'http://127.0.0.1:9');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Install it from https://ollama.com/download');
  });
});

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { homeDir, openEngine, readConfig, writeConfig, type ModelConfig } from '../home.ts';

// `tooldrop init`: bring your own model (SPEC, Local LLM usage). Local Ollama
// by default, sized to the machine's memory; or any OpenAI-compatible endpoint.

/** Machines sold as 16 GB report a little less, so the 14B threshold is 15 GiB. */
const LARGE_MODEL_BYTES = 15 * 1024 ** 3;
const REASONING_MODEL = 'llama3.1:8b';

export function recommendedModels(memoryBytes: number): ModelConfig['models'] {
  return {
    code: memoryBytes >= LARGE_MODEL_BYTES ? 'qwen2.5-coder:14b' : 'qwen2.5-coder:7b',
    reasoning: REASONING_MODEL,
  };
}

/** Ollama's address from OLLAMA_HOST (which may omit the scheme or port), or the default. */
export function ollamaUrl(host = process.env.OLLAMA_HOST): string {
  if (!host) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  const url = new URL(withScheme);
  if (!url.port) url.port = '11434';
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.origin;
}

export async function init(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      provider: { type: 'string' },
      'base-url': { type: 'string' },
      'code-model': { type: 'string' },
      'reasoning-model': { type: 'string' },
      'skip-pull': { type: 'boolean', default: false },
      'skip-browser': { type: 'boolean', default: false },
    },
  });
  const interactive = process.stdin.isTTY && !values.yes;
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (question: string, fallback: string) =>
    ((await prompt?.question(`${question} [${fallback}] `))?.trim() ?? '') || fallback;

  try {
    // The database, so tools can be added right away.
    await openEngine().close();
    console.log(`toolDrop keeps its data in ${homeDir()}\n`);

    const memory = totalmem();
    const recommended = recommendedModels(memory);
    console.log(`This machine has ${(memory / 1024 ** 3).toFixed(1)} GiB of memory.`);

    const provider =
      values.provider ??
      ((await ask(
        'Models: 1) Ollama on this machine (recommended), 2) an OpenAI-compatible endpoint?',
        '1',
      )) === '2'
        ? 'openai_compatible'
        : 'ollama');

    let llm: ModelConfig;
    if (provider === 'ollama') {
      const baseUrl = values['base-url'] ?? ollamaUrl();
      llm = {
        provider: 'ollama',
        base_url: baseUrl,
        models: {
          code: values['code-model'] ?? recommended.code,
          reasoning: values['reasoning-model'] ?? recommended.reasoning,
        },
      };
      console.log(
        `Recommended: ${llm.models.code} for recipes and repairs, ${llm.models.reasoning} for reasoning.`,
      );
      await setUpOllama(llm, { pull: !values['skip-pull'], confirm: interactive ? ask : undefined });
    } else {
      const baseUrl =
        values['base-url'] ?? (await ask('Endpoint base URL (e.g. http://127.0.0.1:8080/v1)?', ''));
      if (!baseUrl) throw new Error('an OpenAI-compatible endpoint needs --base-url');
      const model = values['code-model'] ?? (await ask('Model name?', 'default'));
      llm = {
        provider: 'openai_compatible',
        base_url: baseUrl,
        models: { code: model, reasoning: values['reasoning-model'] ?? model },
      };
      console.log(
        '\nEndpoints that need an API key arrive with the encrypted vault (Phase 3). toolDrop never stores a key in plain text,',
      );
      console.log('so for now use an endpoint without a key, such as llama.cpp, vLLM or LM Studio.');
      if (!/^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?/.test(baseUrl)) {
        console.log(
          'This endpoint is not on this machine: prompts will leave it, with personal data redacted.',
        );
      }
    }
    writeConfig({ ...readConfig(), llm });
    console.log(`Saved the model settings to ${join(homeDir(), 'config.json')}.\n`);

    if (!values['skip-browser']) installBrowser();

    console.log(`Ready. Add toolDrop to your MCP client, for example Claude Desktop:

  { "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }

Other clients: https://nabeelali0707.github.io/toolDrop/getting-started`);
    return 0;
  } finally {
    prompt?.close();
  }
}

async function setUpOllama(
  llm: ModelConfig,
  options: { pull: boolean; confirm: ((question: string, fallback: string) => Promise<string>) | undefined },
): Promise<void> {
  const version = await fetchJson<{ version: string }>(`${llm.base_url}/api/version`);
  if (!version) {
    console.log(`
Ollama is not running at ${llm.base_url}. Install it from https://ollama.com/download, start it,
and run \`npx -y tooldrop init\` again. Published tools run without it; you need it to build and repair tools.`);
    return;
  }
  console.log(`Found Ollama ${version.version} at ${llm.base_url}.`);

  const installed =
    (await fetchJson<{ models: { name: string }[] }>(`${llm.base_url}/api/tags`))?.models ?? [];
  const names = new Set(installed.map((model) => model.name));
  const missing = [...new Set([llm.models.code, llm.models.reasoning])].filter(
    (model) => !names.has(model) && !names.has(`${model}:latest`),
  );
  if (missing.length === 0) {
    console.log('Both models are already downloaded.');
    return;
  }
  if (!options.pull) {
    console.log(
      `Not downloading ${missing.join(' and ')} (--skip-pull). Run \`ollama pull <model>\` when ready.`,
    );
    return;
  }
  if (
    options.confirm &&
    (await options.confirm(`Download ${missing.join(' and ')} now (several GB)? y/n`, 'y')) !== 'y'
  ) {
    console.log(`Skipped. Run \`ollama pull <model>\` when ready.`);
    return;
  }
  for (const model of missing) await pull(llm.base_url, model);
}

async function pull(baseUrl: string, model: string): Promise<void> {
  console.log(`Downloading ${model}...`);
  const response = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!response.ok || !response.body) throw new Error(`Ollama could not pull ${model} (${response.status})`);

  let buffered = '';
  let lastShown = -10;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as {
        status?: string;
        error?: string;
        total?: number;
        completed?: number;
      };
      if (event.error) throw new Error(`Ollama could not pull ${model}: ${event.error}`);
      if (event.total && event.completed !== undefined) {
        const percent = Math.floor((event.completed / event.total) * 100);
        if (percent >= lastShown + 10) {
          console.log(`  ${percent}%`);
          lastShown = percent;
        }
      }
    }
  }
  console.log(`  ${model} is ready.`);
}

function installBrowser(): void {
  console.log('Installing Chromium for the browser strategy (Playwright)...');
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  if (result.status !== 0)
    console.log('Could not install Chromium; browser tools will fail until it is installed.');
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

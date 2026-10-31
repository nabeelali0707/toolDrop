import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findKeyStore, readSealed, Vault } from '@tooldrop/auth';
import { ToolDropError } from '@tooldrop/core';
import { openDatabase, runMigrations } from '@tooldrop/db';
import { Engine, type EngineOptions } from '@tooldrop/engine';
import { defaultSettings, llmSettingsSchema, modelSetup, type LlmSettings } from '@tooldrop/llm';
import { BullMqQueue, ValkeySmsCodes } from '@tooldrop/server';

// Where toolDrop keeps its data: ~/.tooldrop, or TOOLDROP_HOME (DECISIONS.md, D-022).

export function homeDir(): string {
  return process.env.TOOLDROP_HOME ?? join(homedir(), '.tooldrop');
}

/** toolDrop's version, from package.json (the same path works from src/ and from the dist/ bundle). */
export function version(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

export interface Config {
  llm?: LlmSettings;
}

const configPath = () => join(homeDir(), 'config.json');

export function readConfig(): Config {
  return existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as Config) : {};
}

export function writeConfig(config: Config): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  if (process.platform !== 'win32') chmodSync(configPath(), 0o600);
}

/** The model settings from config.json, or local Ollama with the default models before `init` ran. */
export function modelSettings(): LlmSettings {
  const configured = readConfig().llm;
  return configured ? llmSettingsSchema.parse(configured) : defaultSettings();
}

/**
 * The dashboard's built pages: next to the bundle in the published package,
 * or the Next.js export in the repository. Undefined when it was never built.
 */
export function dashboardDir(): string | undefined {
  return ['../dashboard', '../../dashboard/out']
    .map((path) => fileURLToPath(new URL(path, import.meta.url)))
    .find((path) => existsSync(join(path, 'index.html')));
}

/** Where the model endpoint's API key is kept, sealed by the vault. */
export function llmKeyPath(): string {
  return join(homeDir(), 'secrets', 'llm-api-key');
}

/** What the sealed file holds: the key with its endpoint, so it is never sent to another one. */
export interface SavedApiKey {
  base_url: string;
  api_key: string;
}

/** The endpoint's API key, unsealed when the first model call needs it; undefined when none was saved for it. */
async function llmApiKey(baseUrl: string): Promise<string | undefined> {
  if (!existsSync(llmKeyPath())) return undefined;
  const vault = await Vault.open(await findKeyStore({ home: homeDir() }));
  const saved = JSON.parse(readSealed(llmKeyPath(), vault) ?? '{}') as Partial<SavedApiKey>;
  return saved.base_url === baseUrl ? saved.api_key : undefined;
}

/**
 * The database: Postgres when TOOLDROP_DATABASE_URL is set, as self-hosted
 * toolDrop does (DECISIONS.md, D-051), or else the SQLite file in the home
 * directory. The password may come from TOOLDROP_DATABASE_PASSWORD_FILE, as
 * the Compose stack's secret does (D-053). The URL may hold a password, so
 * errors never repeat it.
 */
export function databaseTarget(env: NodeJS.ProcessEnv = process.env): { target: string; password?: string } {
  const url = env.TOOLDROP_DATABASE_URL;
  if (!url) return { target: join(homeDir(), 'tooldrop.db') };
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new ToolDropError('invalid_input', 'TOOLDROP_DATABASE_URL must be a postgres:// URL');
  }
  const file = env.TOOLDROP_DATABASE_PASSWORD_FILE;
  if (!file) return { target: url };
  try {
    return { target: url, password: readFileSync(file, 'utf8').trim() };
  } catch {
    throw new ToolDropError(
      'invalid_input',
      `cannot read TOOLDROP_DATABASE_PASSWORD_FILE (${file}); it must be readable by the user toolDrop runs as`,
    );
  }
}

/**
 * Valkey, when TOOLDROP_VALKEY_URL is set, as self-hosted toolDrop does
 * (DECISIONS.md, D-052): the job queues and SMS codes every process shares.
 * The URL may hold a password, so errors never repeat it.
 */
export function valkeyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.TOOLDROP_VALKEY_URL;
  if (!url) return undefined;
  if (!/^rediss?:\/\//.test(url)) {
    throw new ToolDropError('invalid_input', 'TOOLDROP_VALKEY_URL must be a redis:// or rediss:// URL');
  }
  return url;
}

/**
 * The shared queues and SMS codes on Valkey, or nothing locally, where each
 * process keeps its own. Only `worker` processes take jobs from the queues:
 * one-shot commands add jobs for `tooldrop serve` to run.
 */
async function sharedParts(
  worker: boolean,
): Promise<Pick<EngineOptions, 'heals' | 'sms'> & { builds?: BullMqQueue }> {
  const url = valkeyUrl();
  if (!url) return {};
  const builds = await BullMqQueue.connect('builds', { url, worker });
  const heals = await BullMqQueue.connect('heals', { url, worker }).catch(async (error: unknown) => {
    await builds.close();
    throw error;
  });
  return { builds, heals: { queue: heals }, sms: new ValkeySmsCodes({ url }) };
}

/**
 * Opens the database, applies migrations and starts an engine. `worker` is
 * for the processes that keep running (`serve` and `mcp`), which take jobs
 * from a shared queue.
 */
export async function openEngine(options: { backgroundHeals?: boolean; worker?: boolean } = {}): Promise<{
  engine: Engine;
  close: () => Promise<void>;
}> {
  mkdirSync(homeDir(), { recursive: true });
  const database = databaseTarget();
  const handle = openDatabase(database.target, database);
  let shared: Awaited<ReturnType<typeof sharedParts>>;
  try {
    await runMigrations(handle.db);
    shared = await sharedParts(options.worker === true);
  } catch (error) {
    await handle.close();
    throw error;
  }
  const settings = modelSettings();
  const { builds: buildQueue, ...parts } = shared;
  const engine = new Engine({
    db: handle.db,
    dataDir: homeDir(),
    builds: {
      models: modelSetup(settings, { apiKey: () => llmApiKey(settings.base_url) }),
      ...(buildQueue && { queue: buildQueue }),
    },
    keyStore: () => findKeyStore({ home: homeDir() }),
    ...(options.backgroundHeals === false && { backgroundHeals: false }),
    ...parts,
  });
  return {
    engine,
    close: async () => {
      await engine.close();
      await handle.close();
    },
  };
}

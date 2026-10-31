import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findKeyStore, readSealed, Vault } from '@tooldrop/auth';
import { ToolDropError } from '@tooldrop/core';
import { openDatabase, runMigrations } from '@tooldrop/db';
import { Engine } from '@tooldrop/engine';
import { defaultSettings, llmSettingsSchema, modelSetup, type LlmSettings } from '@tooldrop/llm';

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
 * directory. The URL may hold a password, so errors never repeat it.
 */
export function databaseTarget(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TOOLDROP_DATABASE_URL;
  if (!url) return join(homeDir(), 'tooldrop.db');
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new ToolDropError('invalid_input', 'TOOLDROP_DATABASE_URL must be a postgres:// URL');
  }
  return url;
}

/** Opens the database, applies migrations and starts an engine. */
export async function openEngine(options: { backgroundHeals?: boolean } = {}): Promise<{
  engine: Engine;
  close: () => Promise<void>;
}> {
  mkdirSync(homeDir(), { recursive: true });
  const handle = openDatabase(databaseTarget());
  try {
    await runMigrations(handle.db);
  } catch (error) {
    await handle.close();
    throw error;
  }
  const settings = modelSettings();
  const engine = new Engine({
    db: handle.db,
    dataDir: homeDir(),
    builds: { models: modelSetup(settings, { apiKey: () => llmApiKey(settings.base_url) }) },
    keyStore: () => findKeyStore({ home: homeDir() }),
    ...(options.backgroundHeals === false && { backgroundHeals: false }),
  });
  return {
    engine,
    close: async () => {
      await engine.close();
      await handle.close();
    },
  };
}

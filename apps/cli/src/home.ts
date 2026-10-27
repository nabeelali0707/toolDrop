import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findKeyStore } from '@tooldrop/auth';
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

/** Opens the database in the home directory, applies migrations and starts an engine. */
export function openEngine(): { engine: Engine; close: () => Promise<void> } {
  mkdirSync(homeDir(), { recursive: true });
  const handle = openDatabase(join(homeDir(), 'tooldrop.db'));
  runMigrations(handle.db);
  const engine = new Engine({
    db: handle.db,
    dataDir: homeDir(),
    builds: { models: modelSetup(modelSettings()) },
    keyStore: () => findKeyStore({ home: homeDir() }),
  });
  return {
    engine,
    close: async () => {
      await engine.close();
      handle.close();
    },
  };
}

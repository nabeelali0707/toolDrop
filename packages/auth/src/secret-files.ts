import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Vault } from './vault/vault.ts';

// A secret that is not a login, such as a model endpoint's API key (SPEC,
// Providers: "an optional API key, kept in the vault"): sealed by the vault,
// in a file only its owner can read.

export function writeSealed(path: string, vault: Vault, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, vault.seal(value), { mode: 0o600 });
}

export function readSealed(path: string, vault: Vault): string | undefined {
  if (!existsSync(path)) return undefined;
  return vault.open(readFileSync(path)).toString('utf8');
}

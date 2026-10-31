import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AsyncEntry, type EntryOptions } from '@napi-rs/keyring';
import { ToolDropError } from '@tooldrop/core';

// Where the vault's master key lives (SPEC, Authentication; DECISIONS.md,
// D-009): the OS keychain locally, or a key file mounted into the container
// when self-hosted. Never an environment variable, a log or the database.

export interface KeyStore {
  /** Said in messages, e.g. "the OS keychain". */
  readonly label: string;
  /** Whether toolDrop may create the key here on first use. A mounted file is the operator's to create. */
  readonly creatable: boolean;
  /** The key as base64, or undefined when none exists yet. Throws when the store cannot be read. */
  read(): Promise<string | undefined>;
  write(encoded: string): Promise<void>;
}

/** What the keychain needs from `@napi-rs/keyring`; tests pass a stand-in. */
type EntryClass = new (
  service: string,
  account: string,
  options: EntryOptions,
) => Pick<AsyncEntry, 'getPassword' | 'setPassword'>;

/**
 * The OS keychain: macOS Keychain, Windows Credential Manager or the Linux
 * Secret Service. On Linux the entry must use the Secret Service: without
 * one, the library would fall back to the kernel keyring, which forgets the
 * key at the next reboot. The entry then cannot be made, the read fails, and
 * findKeyStore uses a key file instead.
 */
export function osKeychain(Entry: EntryClass = AsyncEntry): KeyStore {
  const entry = () => new Entry('tooldrop', 'master-key', { linux: { store: 'secret-service' } });
  return {
    label: 'the OS keychain',
    creatable: true,
    read: async () => (await entry().getPassword()) ?? undefined,
    write: async (encoded) => {
      await entry().setPassword(encoded);
    },
  };
}

/**
 * A file holding the key as base64 (D-009). On Linux and macOS a file that
 * other users can read is refused: the key would no longer be secret.
 */
export function keyFile(path: string, options: { creatable: boolean }): KeyStore {
  return {
    label: path,
    creatable: options.creatable,
    // Promise constructors turn the file system's throws into rejections.
    read: () =>
      new Promise<string | undefined>((resolve) => {
        if (!existsSync(path)) return resolve(undefined);
        if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
          throw new ToolDropError(
            'vault_unavailable',
            `${path} can be read by other users; run \`chmod 600 ${path}\` and start toolDrop again`,
          );
        }
        let encoded: string;
        try {
          encoded = readFileSync(path, 'utf8').trim();
        } catch {
          // Most often a Compose secret still owned by the host user (D-053).
          const user = process.getuid ? ` (uid ${process.getuid()})` : '';
          throw new ToolDropError(
            'vault_unavailable',
            `the user toolDrop runs as${user} cannot read ${path}; give the file to that user, keeping it private`,
          );
        }
        resolve(encoded);
      }),
    // `wx` never overwrites: a second key would lock out everything sealed with the first.
    write: (encoded) =>
      new Promise<void>((resolve) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${encoded}\n`, { mode: 0o600, flag: 'wx' });
        resolve();
      }),
  };
}

/** For tests: a keychain that lives in memory, or one that is unavailable. */
export function memoryKeyStore(options: { unavailable?: boolean; value?: string } = {}): KeyStore {
  let value = options.value;
  const fail = () => Promise.reject(new Error('no keychain on this machine'));
  return {
    label: 'a test keychain',
    creatable: true,
    read: () => (options.unavailable ? fail() : Promise.resolve(value)),
    write: (encoded) => {
      if (options.unavailable) return fail();
      value = encoded;
      return Promise.resolve();
    },
  };
}

/** The Compose secret's mount point (D-009). */
export const COMPOSE_KEY_FILE = '/run/secrets/tooldrop_master_key';

/**
 * Where the master key comes from, in order (D-009):
 * 1. `TOOLDROP_KEY_FILE`, a path (never the key itself);
 * 2. the Compose secret, when it is mounted;
 * 3. the OS keychain;
 * 4. `<home>/master.key`, where there is no keychain, such as headless Linux.
 */
export async function findKeyStore(options: {
  home: string;
  env?: NodeJS.ProcessEnv;
  keychain?: KeyStore;
  composeKeyFile?: string;
  /** For `tooldrop init`, which may create the key in a TOOLDROP_KEY_FILE that does not exist yet (D-009). */
  init?: boolean;
}): Promise<KeyStore> {
  const env = options.env ?? process.env;
  if (env.TOOLDROP_KEY_FILE) return keyFile(env.TOOLDROP_KEY_FILE, { creatable: options.init === true });
  const compose = options.composeKeyFile ?? COMPOSE_KEY_FILE;
  if (existsSync(compose)) return keyFile(compose, { creatable: false });
  const keychain = options.keychain ?? osKeychain();
  try {
    await keychain.read();
    return keychain;
  } catch {
    return keyFile(join(options.home, 'master.key'), { creatable: true });
  }
}

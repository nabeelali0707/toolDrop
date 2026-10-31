import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findKeyStore, keyFile, memoryKeyStore, osKeychain } from './key-store.ts';
import { Vault } from './vault.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tooldrop-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const posix = process.platform !== 'win32';

describe('Vault', () => {
  it('seals and opens values, and never shows them in the sealed bytes', async () => {
    const vault = await Vault.open(memoryKeyStore());
    const sealed = vault.seal('fixture-password-not-real');
    expect(sealed[0]).toBe(1);
    expect(sealed.toString('latin1')).not.toContain('fixture-password');
    expect(vault.open(sealed).toString()).toBe('fixture-password-not-real');
    expect(vault.openJson(vault.sealJson({ username: 'fixture-user' }))).toEqual({
      username: 'fixture-user',
    });
    // A fresh nonce every time.
    expect(vault.seal('same').equals(vault.seal('same'))).toBe(false);
  });

  it('refuses values that were changed or sealed with another key', async () => {
    const vault = await Vault.open(memoryKeyStore());
    const sealed = vault.seal('secret');
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    expect(() => vault.open(changed)).toThrow(/does not open/);
    const other = await Vault.open(memoryKeyStore());
    expect(() => other.open(sealed)).toThrow(/does not open/);
    expect(() => vault.open(Buffer.from([9, 1, 2]))).toThrow(/unknown format/);
  });

  it('creates the key on first use where it may, and keeps using it', async () => {
    const store = memoryKeyStore();
    const first = await Vault.open(store);
    const again = await Vault.open(store);
    expect(again.open(first.seal('kept')).toString()).toBe('kept');
  });

  it('asks for `tooldrop init` when a mounted key file is missing', async () => {
    const store = keyFile(join(dir, 'missing.key'), { creatable: false });
    await expect(Vault.open(store)).rejects.toMatchObject({
      code: 'vault_unavailable',
      message: expect.stringContaining('tooldrop init') as string,
    });
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(Vault.open(memoryKeyStore({ value: 'c2hvcnQ=' }))).rejects.toThrow(/not 32 bytes/);
  });
});

describe('key files', () => {
  it('writes the key so only its owner can read it, and never overwrites one', async () => {
    const path = join(dir, 'keys', 'master.key');
    const vault = await Vault.open(keyFile(path, { creatable: true }));
    expect(readFileSync(path, 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(keyFile(path, { creatable: true }).write('other')).rejects.toThrow();
    expect((await Vault.open(keyFile(path, { creatable: false }))).open(vault.seal('x')).toString()).toBe(
      'x',
    );
  });

  it.runIf(posix)('refuses a key file other users can read', async () => {
    const path = join(dir, 'master.key');
    writeFileSync(path, `${Buffer.alloc(32, 7).toString('base64')}\n`);
    chmodSync(path, 0o644);
    await expect(Vault.open(keyFile(path, { creatable: false }))).rejects.toThrow(/chmod 600/);
  });

  // As a Compose secret still owned by the host user looks from inside the container.
  it.runIf(posix && process.getuid?.() !== 0)('says when toolDrop cannot read its key file', async () => {
    const path = join(dir, 'unreadable.key');
    writeFileSync(path, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    chmodSync(path, 0o000);
    await expect(Vault.open(keyFile(path, { creatable: false }))).rejects.toThrow(
      /cannot read .*unreadable\.key/,
    );
  });
});

describe('findKeyStore', () => {
  it('uses TOOLDROP_KEY_FILE first, then the Compose secret', async () => {
    const compose = join(dir, 'compose.key');
    writeFileSync(compose, 'x');
    const fromEnv = await findKeyStore({
      home: dir,
      env: { TOOLDROP_KEY_FILE: '/keys/k' },
      composeKeyFile: compose,
    });
    expect(fromEnv).toMatchObject({ label: '/keys/k', creatable: false });
    const mounted = await findKeyStore({ home: dir, env: {}, composeKeyFile: compose });
    expect(mounted).toMatchObject({ label: compose, creatable: false });
  });

  it('uses the keychain, or a key file in the data folder where there is none', async () => {
    const keychain = memoryKeyStore();
    const absent = join(dir, 'no-compose.key');
    expect(await findKeyStore({ home: dir, env: {}, keychain, composeKeyFile: absent })).toBe(keychain);
    const fallback = await findKeyStore({
      home: dir,
      env: {},
      keychain: memoryKeyStore({ unavailable: true }),
      composeKeyFile: absent,
    });
    expect(fallback).toMatchObject({ label: join(dir, 'master.key'), creatable: true });
  });

  it("needs Linux's Secret Service, not the kernel keyring that forgets the key at reboot", async () => {
    const options: unknown[] = [];
    class WithoutSecretService {
      constructor(...args: unknown[]) {
        options.push(args[2]);
        throw new Error('no Secret Service');
      }
      getPassword() {
        return Promise.resolve(null);
      }
      setPassword() {
        return Promise.resolve();
      }
    }
    const keychain = osKeychain(WithoutSecretService);
    await expect(keychain.read()).rejects.toThrow('no Secret Service');
    expect(options).toEqual([{ linux: { store: 'secret-service' } }]);
    const store = await findKeyStore({
      home: dir,
      env: {},
      keychain,
      composeKeyFile: join(dir, 'no-compose.key'),
    });
    expect(store).toMatchObject({ label: join(dir, 'master.key'), creatable: true });
  });
});

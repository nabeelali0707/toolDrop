import { ToolDropError } from '@tooldrop/core';
import sodium from 'libsodium-wrappers';
import type { KeyStore } from './key-store.ts';

// The vault (SPEC, Authentication): secrets sealed with libsodium's secretbox
// (XSalsa20-Poly1305) under one master key. A sealed value is a format byte,
// a random nonce and the box, so a later key rotation can tell formats apart.

const FORMAT = 1;

export class Vault {
  readonly #key: Uint8Array;
  /** Where the key came from, for messages. */
  readonly source: string;

  private constructor(key: Uint8Array, source: string) {
    this.#key = key;
    this.source = source;
  }

  /**
   * Opens the vault with the store's key. A store that may hold a new key
   * gets one on first use; any other store must already have it.
   */
  static async open(store: KeyStore): Promise<Vault> {
    await sodium.ready;
    let encoded: string | undefined;
    try {
      encoded = await store.read();
    } catch (error) {
      if (error instanceof ToolDropError) throw error;
      throw new ToolDropError('vault_unavailable', `cannot read the master key from ${store.label}`, {
        cause: error,
      });
    }
    if (encoded === undefined) {
      if (!store.creatable) {
        throw new ToolDropError(
          'vault_unavailable',
          `there is no master key in ${store.label}; create one with \`tooldrop init\``,
        );
      }
      const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
      await store.write(sodium.to_base64(key, sodium.base64_variants.ORIGINAL));
      return new Vault(key, store.label);
    }
    let key: Uint8Array;
    try {
      key = sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL);
    } catch {
      key = new Uint8Array();
    }
    if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new ToolDropError(
        'vault_unavailable',
        `the master key in ${store.label} is not 32 bytes of base64`,
      );
    }
    return new Vault(key, store.label);
  }

  seal(data: string | Uint8Array): Buffer {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const box = sodium.crypto_secretbox_easy(data, nonce, this.#key);
    return Buffer.concat([Buffer.from([FORMAT]), nonce, box]);
  }

  /** Opens a sealed value. Fails on a value sealed with another key, or changed since. */
  open(sealed: Uint8Array): Buffer {
    const nonceEnd = 1 + sodium.crypto_secretbox_NONCEBYTES;
    if (sealed[0] !== FORMAT || sealed.length <= nonceEnd + sodium.crypto_secretbox_MACBYTES) {
      throw new ToolDropError('vault_unavailable', 'a sealed value has an unknown format');
    }
    try {
      return Buffer.from(
        sodium.crypto_secretbox_open_easy(sealed.subarray(nonceEnd), sealed.subarray(1, nonceEnd), this.#key),
      );
    } catch (error) {
      throw new ToolDropError('vault_unavailable', 'a sealed value does not open with this master key', {
        cause: error,
      });
    }
  }

  sealJson(value: unknown): Buffer {
    return this.seal(JSON.stringify(value));
  }

  openJson<T>(sealed: Uint8Array): T {
    return JSON.parse(this.open(sealed).toString('utf8')) as T;
  }
}

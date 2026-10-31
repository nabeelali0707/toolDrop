import { createHash, randomUUID } from 'node:crypto';
import {
  extractCode,
  noSmsInTime,
  sameSender,
  SMS_MAX_AGE_MS,
  SMS_WAIT_MS,
  type InboundSms,
  type SmsCodes,
  type SmsWait,
} from '@tooldrop/auth';
import { Redis } from 'ioredis';

// SMS codes on Valkey, for self-hosted toolDrop (SPEC, SMS codes;
// DECISIONS.md, D-049 and D-052): the process that receives a forwarded
// message and the one whose sign-in waits for it may differ. Only codes reach
// Valkey, never a message's text, and each expires after 5 minutes. A waiting
// login leaves its sender and pattern there; the process that receives a
// message reads the code with them and publishes it to that login alone.

interface Waiting {
  sender?: string;
  pattern?: string;
  /** When the login stops waiting, in milliseconds. */
  until: number;
}

/** A code no login was waiting for when it came. */
interface Unclaimed {
  from: string;
  arrived: number;
  code: string;
}

export class ValkeySmsCodes implements SmsCodes {
  readonly #redis: Redis;
  readonly #keys: { seen: string; waiting: string; unclaimed: string; channel: string };
  readonly #listeners = new Map<string, (code: string) => void>();
  readonly #now: () => number;
  #subscriber: Promise<Redis> | undefined;

  constructor(options: { url: string; prefix?: string; now?: () => number }) {
    const prefix = `${options.prefix ?? 'tooldrop'}:sms`;
    this.#redis = new Redis(options.url);
    // The client reconnects by itself; a lost connection must not end the process.
    this.#redis.on('error', () => undefined);
    this.#keys = {
      seen: `${prefix}:seen:`,
      waiting: `${prefix}:waiting`,
      unclaimed: `${prefix}:unclaimed`,
      channel: `${prefix}:codes`,
    };
    this.#now = options.now ?? Date.now;
  }

  async accept(message: InboundSms): Promise<'accepted' | 'stale' | 'duplicate'> {
    const now = this.#now();
    if (now - message.received_at > SMS_MAX_AGE_MS) return 'stale';
    const hash = createHash('sha256')
      .update(`${message.from}\n${message.received_at}\n${message.text}`)
      .digest('hex');
    const fresh = await this.#redis.set(`${this.#keys.seen}${hash}`, '1', 'PX', SMS_MAX_AGE_MS, 'NX');
    if (fresh === null) return 'duplicate';

    for (const [id, json] of Object.entries(await this.#redis.hgetall(this.#keys.waiting))) {
      const waiting = JSON.parse(json) as Waiting;
      if (waiting.until < now) {
        await this.#redis.hdel(this.#keys.waiting, id);
        continue;
      }
      if (waiting.sender && !sameSender(waiting.sender, message.from)) continue;
      const code = extractCode(message.text, waiting.pattern);
      if (!code) continue;
      // Removing the entry is the claim: the code goes to one login, from one process.
      if ((await this.#redis.hdel(this.#keys.waiting, id)) === 1) {
        await this.#redis.publish(this.#keys.channel, JSON.stringify({ id, code }));
        return 'accepted';
      }
    }
    const code = extractCode(message.text);
    if (code) {
      const entry: Unclaimed = { from: message.from, arrived: now, code };
      await this.#redis
        .multi()
        .rpush(this.#keys.unclaimed, JSON.stringify(entry))
        .pexpire(this.#keys.unclaimed, SMS_MAX_AGE_MS)
        .exec();
    }
    return 'accepted';
  }

  async waitForCode(options: SmsWait): Promise<string> {
    // A custom pattern needs the message's text, which is never kept, so only a new message serves it.
    const stored = options.pattern ? undefined : await this.#takeUnclaimed(options);
    if (stored) return stored;

    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? SMS_WAIT_MS;
    const arrived = new Promise<string>((resolve) => this.#listeners.set(id, resolve));
    try {
      // Listening before registering, so a code published at once is not missed.
      await this.#subscribe();
      const waiting: Waiting = {
        ...(options.sender && { sender: options.sender }),
        ...(options.pattern && { pattern: options.pattern }),
        until: this.#now() + timeoutMs,
      };
      await this.#redis.hset(this.#keys.waiting, id, JSON.stringify(waiting));
      // A message may have come between the first look and registering.
      const late = options.pattern ? undefined : await this.#takeUnclaimed(options);
      if (late) return late;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(noSmsInTime()), timeoutMs);
      });
      try {
        return await Promise.race([arrived, timeout]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.#listeners.delete(id);
      await this.#redis.hdel(this.#keys.waiting, id).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const subscriber = await this.#subscriber?.catch(() => undefined);
    subscriber?.disconnect();
    this.#redis.disconnect();
  }

  /** Takes the first unclaimed code for a login, if one came after it began. */
  async #takeUnclaimed(options: SmsWait): Promise<string | undefined> {
    const now = this.#now();
    for (const json of await this.#redis.lrange(this.#keys.unclaimed, 0, -1)) {
      const entry = JSON.parse(json) as Unclaimed;
      if (now - entry.arrived > SMS_MAX_AGE_MS) {
        await this.#redis.lrem(this.#keys.unclaimed, 1, json);
        continue;
      }
      if (entry.arrived < options.after) continue;
      if (options.sender && !sameSender(options.sender, entry.from)) continue;
      // Removing it is the claim: of two logins waiting, one gets the code.
      if ((await this.#redis.lrem(this.#keys.unclaimed, 1, json)) === 1) return entry.code;
    }
    return undefined;
  }

  #subscribe(): Promise<Redis> {
    this.#subscriber ??= (async () => {
      const subscriber = this.#redis.duplicate();
      subscriber.on('error', () => undefined);
      subscriber.on('message', (_channel: string, text: string) => {
        const { id, code } = JSON.parse(text) as { id: string; code: string };
        this.#listeners.get(id)?.(code);
      });
      await subscriber.subscribe(this.#keys.channel);
      return subscriber;
    })();
    return this.#subscriber;
  }
}

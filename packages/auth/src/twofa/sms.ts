import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ToolDropError } from '@tooldrop/core';

// SMS codes from the person's own phone (SPEC, Authentication; DECISIONS.md,
// D-008): an open-source forwarder app posts each SMS to toolDrop's webhook.
// A login waiting for a code takes the first message from its sender that
// arrived after the sign-in started. Only codes are kept, in memory, for at
// most 5 minutes; message text is never stored or logged.

/** Older messages are dropped: the forwarder's signature carries no timestamp, so this stops replays. */
export const SMS_MAX_AGE_MS = 5 * 60_000;
/** The default code: the first number of 4 to 8 digits. */
const DEFAULT_CODE = /(?<!\d)(\d{4,8})(?!\d)/;

export interface InboundSms {
  from: string;
  text: string;
  /** When the phone received it, in milliseconds. */
  received_at: number;
}

/**
 * A forwarder's JSON: SMS to URL Forwarder's template
 * (`{"from":"%from%","text":"%text%","receivedStamp":"%receivedStamp%"}`), or
 * the field names other forwarders use. Undefined when it is not an SMS.
 */
export function parseInboundSms(body: unknown, now = Date.now()): InboundSms | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const pick = (...names: string[]) =>
    names.map((name) => record[name]).find((value) => typeof value === 'string' || typeof value === 'number');
  const from = pick('from', 'sender', 'phone', 'phoneNumber', 'number');
  const text = pick('text', 'message', 'body', 'content');
  if (from === undefined || text === undefined) return undefined;
  const stamp = Number(pick('receivedStamp', 'received_at', 'receivedAt', 'timestamp', 'time') ?? now);
  // Seconds or milliseconds; a forwarder without a time counts as now.
  const received = Number.isFinite(stamp) ? (stamp < 1e12 ? stamp * 1000 : stamp) : now;
  return { from: String(from), text: String(text), received_at: received };
}

/**
 * Whether a request comes from the person's forwarder: a hex HMAC-SHA256 of
 * the raw body in `X-Signature`, as SMS to URL Forwarder sends, or the secret
 * as a bearer token, for forwarders that cannot sign.
 */
export function verifySmsRequest(
  secret: string,
  rawBody: string,
  headers: { signature?: string | undefined; authorization?: string | undefined },
): boolean {
  const same = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (headers.signature) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return same(headers.signature.replace(/^sha256=/i, '').toLowerCase(), expected);
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
  return bearer !== undefined && same(bearer, secret);
}

/** Phone numbers and sender names compare without spacing, signs and a country code's lead. */
function sameSender(expected: string, actual: string): boolean {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = clean(expected);
  const b = clean(actual);
  return a !== '' && (a === b || a.endsWith(b) || b.endsWith(a));
}

/** The code in a message: the pattern's first group, or its whole match. */
export function extractCode(text: string, pattern?: string): string | undefined {
  const match = (pattern ? new RegExp(pattern) : DEFAULT_CODE).exec(text);
  return match ? (match[1] ?? match[0]) : undefined;
}

interface Waiter {
  sender?: string | undefined;
  pattern?: string | undefined;
  after: number;
  resolve: (code: string) => void;
}

/** Codes from forwarded messages, waiting for the logins that asked for them. */
export class SmsInbox {
  /** Messages no login has taken yet: who sent them, when, and their code. Never their text. */
  readonly #codes: { from: string; arrived: number; code: string }[] = [];
  /** Hashes of messages already taken in, to drop a forwarder's retries. */
  readonly #seen = new Map<string, number>();
  readonly #waiters = new Set<Waiter>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Takes a forwarded message in, unless it is stale or seen before. */
  accept(message: InboundSms): 'accepted' | 'stale' | 'duplicate' {
    const now = this.#now();
    this.#prune(now);
    if (now - message.received_at > SMS_MAX_AGE_MS) return 'stale';
    const hash = createHash('sha256')
      .update(`${message.from}\n${message.received_at}\n${message.text}`)
      .digest('hex');
    if (this.#seen.has(hash)) return 'duplicate';
    this.#seen.set(hash, now + SMS_MAX_AGE_MS);

    for (const waiter of this.#waiters) {
      if (waiter.sender && !sameSender(waiter.sender, message.from)) continue;
      const code = extractCode(message.text, waiter.pattern);
      if (!code) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(code);
      return 'accepted';
    }
    const code = extractCode(message.text);
    if (code) this.#codes.push({ from: message.from, arrived: now, code });
    return 'accepted';
  }

  /**
   * The code for a login: the first message from its sender that arrived
   * after `after`, now or within `timeoutMs`.
   */
  waitForCode(options: {
    sender?: string;
    pattern?: string;
    after: number;
    timeoutMs?: number;
  }): Promise<string> {
    this.#prune(this.#now());
    const index = this.#codes.findIndex(
      (entry) =>
        entry.arrived >= options.after && (!options.sender || sameSender(options.sender, entry.from)),
    );
    const found = this.#codes[index];
    if (found && !options.pattern) {
      this.#codes.splice(index, 1);
      return Promise.resolve(found.code);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#waiters.delete(waiter);
          reject(
            new ToolDropError(
              'session_expired',
              'no SMS code arrived in time; check that the forwarder on your phone is on and points at toolDrop',
            ),
          );
        },
        options.timeoutMs ?? 3 * 60_000,
      );
      const waiter: Waiter = {
        sender: options.sender,
        pattern: options.pattern,
        after: options.after,
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code);
        },
      };
      this.#waiters.add(waiter);
    });
  }

  #prune(now: number): void {
    for (let i = this.#codes.length - 1; i >= 0; i--) {
      if (now - (this.#codes[i]?.arrived ?? 0) > SMS_MAX_AGE_MS) this.#codes.splice(i, 1);
    }
    for (const [hash, until] of this.#seen) if (until < now) this.#seen.delete(hash);
  }
}

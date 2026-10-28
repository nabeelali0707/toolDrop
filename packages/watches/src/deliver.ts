import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WatchEvent } from '@tooldrop/core';

// Webhook delivery (SPEC, Watches; the format is in docs/watches-and-webhooks
// and DECISIONS.md, D-029): one POST per event, signed with HMAC-SHA256 over
// the timestamp and the raw body, retried with backoff.

/** Receivers reject requests older than this, so a captured one cannot be replayed later. */
export const SIGNATURE_TOLERANCE_S = 300;

/** The `X-Tooldrop-Signature` header for a body sent at `timestamp` (seconds). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** What a receiver checks: a fresh timestamp and a matching signature. */
export function verifyWebhook(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  now = Date.now(),
): boolean {
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!(age < SIGNATURE_TOLERANCE_S)) return false;
  const expected = Buffer.from(signWebhook(secret, Number(timestamp), body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface DeliveryOptions {
  fetch?: typeof fetch;
  /** Waits before each retry (default 1 s, 5 s and 25 s: four tries in all). */
  backoffMs?: readonly number[];
  /** How long one try may take (default 10 s). */
  timeoutMs?: number;
}

export interface Delivery {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

const BACKOFF_MS = [1_000, 5_000, 25_000];

/**
 * Posts one event. Network errors, timeouts, 408, 429 and 5xx answers are
 * tried again; other answers mean the receiver refused it. Redirects are not
 * followed, so a signed event only ever reaches the URL it was meant for.
 */
export async function deliver(
  url: string,
  event: WatchEvent,
  secret: string,
  options: DeliveryOptions = {},
): Promise<Delivery> {
  const body = JSON.stringify(event);
  const waits = options.backoffMs ?? BACKOFF_MS;
  let last: Delivery = { ok: false, attempts: 0 };
  for (let attempt = 1; attempt <= waits.length + 1; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, waits[attempt - 2]));
    // Signed again on every try, so a late retry still has a fresh timestamp.
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'toolDrop-webhooks',
          'x-tooldrop-event': event.id,
          'x-tooldrop-timestamp': String(timestamp),
          'x-tooldrop-signature': signWebhook(secret, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      await response.body?.cancel();
      if (response.ok) return { ok: true, attempts: attempt, status: response.status };
      last = {
        ok: false,
        attempts: attempt,
        status: response.status,
        error: `the webhook answered ${response.status}`,
      };
      if (!retryable(response.status)) return last;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      last = { ok: false, attempts: attempt, error: `the webhook could not be reached: ${reason}` };
    }
  }
  return last;
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

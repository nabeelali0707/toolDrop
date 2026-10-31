import { randomBytes } from 'node:crypto';
import type { QueuedJob } from '@tooldrop/engine';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { BullMqQueue } from './jobs/bullmq-queue.ts';
import { ValkeySmsCodes } from './valkey-sms.ts';

// The shared queue and SMS codes on a real Valkey server (D-052). CI runs
// them against a Valkey 8.1 service; locally they run when
// TOOLDROP_TEST_VALKEY_URL points at a server. Each test has its own key
// prefix, and two instances stand for two toolDrop processes.

const url = process.env.TOOLDROP_TEST_VALKEY_URL ?? '';
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closable of opened.splice(0)) await closable.close();
});

const prefix = () => `tooldrop-test-${randomBytes(4).toString('hex')}`;
const job = (id: string): QueuedJob => ({ id, kind: 'build' });

async function queue(name: string, options: { prefix: string; worker?: boolean }): Promise<BullMqQueue> {
  const opened_ = await BullMqQueue.connect(name, { url, ...options });
  opened.push(opened_);
  return opened_;
}

function codes(keyPrefix: string, now?: () => number): ValkeySmsCodes {
  const store = new ValkeySmsCodes({ url, prefix: keyPrefix, ...(now && { now }) });
  opened.push(store);
  return store;
}

describe.runIf(url)('the queue on Valkey', () => {
  it('runs a job added in one process in another, once', async () => {
    const keys = prefix();
    const adder = await queue('builds', { prefix: keys, worker: false });
    const runner = await queue('builds', { prefix: keys });
    const ran: string[] = [];
    let release = () => undefined as void;
    const done = new Promise<void>((resolve) => (release = resolve));
    adder.process(() => Promise.reject(new Error('a process without a worker never takes a job')));
    runner.process((taken) => {
      ran.push(taken.id);
      release();
      return Promise.resolve();
    });

    await adder.enqueue(job('01JOB0000000000000000000A1'));
    // The same job added twice waits once.
    await adder.enqueue(job('01JOB0000000000000000000A1'));
    await done;
    await runner.idle();
    expect(ran).toEqual(['01JOB0000000000000000000A1']);
  });

  it('keeps jobs that wait while no process takes them', async () => {
    const keys = prefix();
    const adder = await queue('heals', { prefix: keys, worker: false });
    await adder.enqueue({ id: '01JOB0000000000000000000B1', kind: 'heal' });

    // A process that starts later, as after a restart, takes it.
    const runner = await queue('heals', { prefix: keys });
    const taken = await new Promise<QueuedJob>((resolve) =>
      runner.process((next) => {
        resolve(next);
        return Promise.resolve();
      }),
    );
    expect(taken).toEqual({ id: '01JOB0000000000000000000B1', kind: 'heal' });
  });

  it('says when Valkey cannot be reached, without the URL', async () => {
    const failed: unknown = await BullMqQueue.connect('builds', {
      url: 'redis://user:not-a-real-password@127.0.0.1:1',
    }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: 'internal' });
    expect(String((failed as Error).message)).not.toContain('not-a-real-password');
  }, 30_000);
});

describe.runIf(url)('SMS codes on Valkey', () => {
  const sms = (text: string, received_at = Date.now(), from = '+1 555 555 0100') => ({
    from,
    text,
    received_at,
  });

  it('hands a code received by one process to the login waiting in another', async () => {
    const keys = prefix();
    const webhook = codes(keys);
    const signIn = codes(keys);
    const waiting = signIn.waitForCode({
      sender: '+15555550100',
      after: Date.now() - 1000,
      timeoutMs: 10_000,
    });
    // Let the login register before the message comes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await webhook.accept(sms('Your code is 482913'))).toBe('accepted');
    expect(await waiting).toBe('482913');
  });

  it('keeps a code no login waits for, for the next login from that sender', async () => {
    const keys = prefix();
    const started = Date.now() - 1000;
    expect(await codes(keys).accept(sms('Code: 120034'))).toBe('accepted');
    expect(
      await codes(keys).waitForCode({ sender: '+1 (555) 555-0100', after: started, timeoutMs: 2_000 }),
    ).toBe('120034');
    // Taken once.
    await expect(codes(keys).waitForCode({ after: started, timeoutMs: 500 })).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  it('refuses stale and repeated messages, and keeps codes only, never text', async () => {
    const keys = prefix();
    const store = codes(keys);
    expect(await store.accept(sms('Old code 111111', Date.now() - 6 * 60_000))).toBe('stale');
    const message = sms('Your bank code is 654321, never share it');
    expect(await store.accept(message)).toBe('accepted');
    expect(await codes(keys).accept(message)).toBe('duplicate');

    const redis = new Redis(url);
    try {
      const stored = (await redis.lrange(`${keys}:sms:unclaimed`, 0, -1)).join('\n');
      expect(stored).toContain('654321');
      expect(stored).not.toContain('bank');
      for (const key of await redis.keys(`${keys}:*`)) {
        expect(await redis.pttl(key)).toBeGreaterThan(0);
      }
    } finally {
      redis.disconnect();
    }
  });
});

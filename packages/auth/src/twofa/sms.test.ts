import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractCode, parseInboundSms, SmsInbox, verifySmsRequest } from './sms.ts';

const secret = 'sms-secret-not-real';
const now = Date.parse('2026-10-28T12:00:00Z');

describe('verifySmsRequest', () => {
  const body = '{"from":"+15555550100","text":"Your code is 482913","receivedStamp":"1793000000000"}';
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the forwarder signature, or the secret as a bearer token', () => {
    expect(verifySmsRequest(secret, body, { signature })).toBe(true);
    expect(verifySmsRequest(secret, body, { authorization: `Bearer ${secret}` })).toBe(true);
  });

  it('refuses a missing, wrong or stale signature, and a changed body', () => {
    expect(verifySmsRequest(secret, body, {})).toBe(false);
    expect(verifySmsRequest(secret, body, { signature: 'deadbeef' })).toBe(false);
    expect(verifySmsRequest(secret, `${body} `, { signature })).toBe(false);
    expect(verifySmsRequest(secret, body, { authorization: 'Bearer another-secret' })).toBe(false);
  });
});

describe('parseInboundSms', () => {
  it("reads SMS to URL Forwarder's template and other forwarders' field names", () => {
    expect(parseInboundSms({ from: 'Bank', text: 'Code 1234', receivedStamp: '1793000000000' })).toEqual({
      from: 'Bank',
      text: 'Code 1234',
      received_at: 1793000000000,
    });
    expect(parseInboundSms({ sender: '+1555', message: 'x', timestamp: 1793000000 }, now)).toMatchObject({
      received_at: 1793000000000,
    });
    expect(parseInboundSms({ from: 'Bank', message: 'x' }, now)).toMatchObject({ received_at: now });
    expect(parseInboundSms({ hello: 'world' })).toBeUndefined();
  });
});

describe('extractCode', () => {
  it('finds a 4 to 8 digit number, or what the login pattern says', () => {
    expect(extractCode('Your code is 482913. Valid 10 minutes.')).toBe('482913');
    expect(extractCode('Call 12 or 123 now')).toBeUndefined();
    expect(extractCode('Ref 2026 code: AB-77', 'code: ([A-Z]+-\\d+)')).toBe('AB-77');
  });
});

describe('SmsInbox', () => {
  const sms = (text: string, received = now, from = '+1 (555) 555-0100') => ({
    from,
    text,
    received_at: received,
  });

  it('drops stale and repeated messages', () => {
    const inbox = new SmsInbox({ now: () => now });
    expect(inbox.accept(sms('Code 482913', now - 6 * 60_000))).toBe('stale');
    expect(inbox.accept(sms('Code 482913'))).toBe('accepted');
    expect(inbox.accept(sms('Code 482913'))).toBe('duplicate');
  });

  it('gives a waiting login the next code from its sender', async () => {
    const inbox = new SmsInbox({ now: () => now });
    const code = inbox.waitForCode({ sender: '+15555550100', after: now, timeoutMs: 1_000 });
    inbox.accept(sms('Code 111111', now, 'Another Bank'));
    inbox.accept(sms('Code 482913'));
    await expect(code).resolves.toBe('482913');
  });

  it('keeps a code that came before the login asked, for at most 5 minutes', async () => {
    let clock = now;
    const inbox = new SmsInbox({ now: () => clock });
    inbox.accept(sms('Code 482913'));
    await expect(inbox.waitForCode({ sender: '5555550100', after: now - 1_000 })).resolves.toBe('482913');

    inbox.accept(sms('Code 777777'));
    clock += 6 * 60_000;
    await expect(inbox.waitForCode({ after: now, timeoutMs: 10 })).rejects.toThrow('no SMS code arrived');
  });
});

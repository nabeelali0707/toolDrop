import hoodiecrow from 'hoodiecrow-imap';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMailbox, waitForEmailCode, type MailboxConfig } from './email.ts';

// Email codes against a local IMAP test server (Hoodiecrow, in memory). Its
// one account is testuser / testpass: test values, never real credentials.

let server: ReturnType<typeof hoodiecrow>;
let mailbox: MailboxConfig;

beforeAll(async () => {
  server = hoodiecrow();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mailbox = {
    host: '127.0.0.1',
    port: server.address().port,
    secure: false,
    user: 'testuser',
    password: 'testpass',
  };
});
afterAll(() => new Promise<void>((resolve) => server.close(resolve)));

/** Delivers a message to the inbox, as the site's mail would arrive. */
async function deliver(from: string, subject: string, text: string, at = new Date()): Promise<void> {
  const imap = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: false,
    auth: { user: 'testuser', pass: 'testpass' },
    logger: false,
  });
  await imap.connect();
  const message = [
    `From: ${from}`,
    'To: testuser@example.test',
    `Subject: ${subject}`,
    `Date: ${at.toUTCString()}`,
    '',
    text,
    '',
  ].join('\r\n');
  await imap.append('INBOX', message, [], at);
  await imap.logout();
}

describe('email codes', () => {
  it('checks the mailbox before it is saved', async () => {
    await expect(checkMailbox(mailbox)).resolves.toBeUndefined();
    await expect(checkMailbox({ ...mailbox, password: 'wrong-password-not-real' })).rejects.toThrow(
      'toolDrop could not open the mailbox of testuser',
    );
  });

  it('reads the code from the first message by its sender after the sign-in began', async () => {
    const began = Date.now();
    await deliver(
      'Example Shop <codes@shop.example.test>',
      'Old code',
      'Your code is 111111',
      new Date(began - 10 * 60_000),
    );
    await deliver('Newsletter <news@shop.example.test>', 'Hello', 'Use promo 222222 today');
    const code = waitForEmailCode(mailbox, {
      sender: 'codes@shop.example.test',
      after: began,
      pollMs: 100,
      timeoutMs: 5_000,
    });
    await deliver(
      'Example Shop <codes@shop.example.test>',
      'Your sign-in code',
      'Your code is 482913. It expires in 10 minutes.',
    );
    await expect(code).resolves.toBe('482913');
  });

  it('says so when no code arrives in time', async () => {
    await expect(
      waitForEmailCode(mailbox, {
        sender: 'nobody@example.test',
        after: Date.now(),
        pollMs: 50,
        timeoutMs: 200,
      }),
    ).rejects.toThrow('no email code arrived in time');
  });
});

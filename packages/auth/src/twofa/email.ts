import { ToolDropError } from '@tooldrop/core';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { extractCode } from './sms.ts';

// Email codes (SPEC, Authentication, 2FA step 2): read from the person's own
// inbox over IMAP, matched by sender and time. The mailbox is opened read-only:
// toolDrop never marks, moves or deletes mail.

export interface MailboxConfig {
  host: string;
  port: number;
  /** TLS from the start (port 993); otherwise STARTTLS when the server offers it. */
  secure: boolean;
  user: string;
  password: string;
}

/** Mail can reach the server a little before the sign-in's own clock says it began. */
const CLOCK_SKEW_MS = 30_000;

function client(config: MailboxConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks that toolDrop can open the mailbox, before it is saved. */
export async function checkMailbox(config: MailboxConfig): Promise<void> {
  const imap = client(config);
  try {
    await imap.connect();
    await imap.logout();
  } catch (error) {
    throw new ToolDropError(
      'invalid_input',
      `toolDrop could not open the mailbox of ${config.user} at ${config.host}: ${reason(error)}`,
    );
  }
}

/**
 * The code from the first message from `sender` that arrived after `after`:
 * read now, then every few seconds until `timeoutMs` has passed.
 */
export async function waitForEmailCode(
  config: MailboxConfig,
  options: { sender?: string; pattern?: string; after: number; timeoutMs?: number; pollMs?: number },
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 3 * 60_000);
  for (;;) {
    const code = await findCode(config, options);
    if (code) return code;
    if (Date.now() >= deadline) {
      throw new ToolDropError(
        'session_expired',
        `no email code arrived in time in the mailbox of ${config.user}; check that the site sends it there`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 5_000));
  }
}

async function findCode(
  config: MailboxConfig,
  options: { sender?: string; pattern?: string; after: number },
): Promise<string | undefined> {
  const imap = client(config);
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
    try {
      // IMAP searches by day; the exact time is checked below.
      const since = new Date(options.after - 86_400_000);
      const uids = await imap.search(
        { since, ...(options.sender && { from: options.sender }) },
        { uid: true },
      );
      if (!uids || uids.length === 0) return undefined;
      const found: { arrived: number; code: string }[] = [];
      for await (const message of imap.fetch(uids, { source: true, internalDate: true }, { uid: true })) {
        const arrived = new Date(message.internalDate ?? 0).getTime();
        if (arrived < options.after - CLOCK_SKEW_MS || !message.source) continue;
        const mail = await simpleParser(message.source);
        const code = extractCode(`${mail.subject ?? ''}\n${mail.text ?? ''}`, options.pattern);
        if (code) found.push({ arrived, code });
      }
      return found.sort((a, b) => a.arrived - b.arrived)[0]?.code;
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => undefined);
  }
}

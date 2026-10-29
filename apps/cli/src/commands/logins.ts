import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import type { StorageState } from '@tooldrop/runtime';
import { chromium } from 'playwright';
import { openEngine } from '../home.ts';
import { askHidden, readStdin } from '../prompt.ts';

const USAGE = `usage:
  tooldrop logins add <site> [--username name] [--label text] [--totp] [--human] [--sms <sender>] [--email <sender>] [--password-stdin]
  tooldrop logins list [--site <url>]
  tooldrop logins verify <site> [--by-hand]`;

/**
 * `tooldrop logins`: save logins without handing them to an agent. The
 * password is typed at a hidden prompt, or piped in with --password-stdin;
 * never an argument, which would end up in the shell history.
 */
export async function logins(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'list') return list(rest);
  if (command === 'add') return add(rest);
  if (command === 'verify') return verify(rest);
  throw new ToolDropError('invalid_input', USAGE);
}

/**
 * Signs in now and keeps the session. It asks here for a code the site sends
 * by hand, or before typing the login on another site's sign-in page. With
 * --by-hand, a browser window opens and you sign in yourself, past a captcha.
 */
async function verify(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'by-hand': { type: 'boolean', default: false } },
  });
  const [site] = positionals;
  if (!site) throw new ToolDropError('invalid_input', USAGE);
  const { engine, close } = openEngine();
  try {
    const ask = async (question: { text: string; options?: string[] }) => {
      if (!process.stdin.isTTY)
        throw new ToolDropError('invalid_input', `${question.text} Run this in a terminal.`);
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await terminal.question(
          `${question.text}${question.options ? ` (${question.options.join('/')})` : ''} `,
        );
      } finally {
        terminal.close();
      }
    };
    if (values['by-hand']) {
      await signInByHand(site, ask, (signedIn) => engine.sessions.saveByHand(site, signedIn));
      console.log(`Signed in to ${new URL(site).origin} by hand; the session is saved.`);
      return 0;
    }
    if (!(await engine.signIn(site, { ask }))) {
      console.error(`There is no saved login for ${site}. Add one with: tooldrop logins add ${site}`);
      return 1;
    }
    console.log(`Signed in to ${new URL(site).origin}; the session is saved.`);
    return 0;
  } finally {
    await close();
  }
}

/**
 * A visible browser where a person signs in themselves, solving any captcha;
 * toolDrop never does (SPEC, Authentication). It notes the last page that
 * asked for a password, which tells toolDrop when the session has ended.
 */
async function signInByHand(
  site: string,
  ask: (question: { text: string }) => Promise<string>,
  save: (signedIn: { state: StorageState; signInUrl: string; landingUrl: string }) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    let signInUrl: string | undefined;
    page.on('load', () => {
      page
        .locator('input[type=password]')
        .count()
        .then((fields) => {
          if (fields > 0) signInUrl = page.url();
        })
        .catch(() => undefined);
    });
    await page.goto(site);
    await ask({ text: 'Sign in in the browser window, solving any captcha. Then press Enter here.' });
    if ((await page.locator('input[type=password]').count()) > 0) {
      throw new ToolDropError(
        'invalid_input',
        'the window still shows a sign-in form; sign in first, then press Enter',
      );
    }
    await save({
      state: await context.storageState(),
      signInUrl: signInUrl ?? site,
      landingUrl: page.url(),
    });
  } finally {
    await browser.close();
  }
}

async function add(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      username: { type: 'string' },
      label: { type: 'string' },
      totp: { type: 'boolean', default: false },
      human: { type: 'boolean', default: false },
      sms: { type: 'string' },
      email: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
    },
  });
  const [site] = positionals;
  if (!site) throw new ToolDropError('invalid_input', USAGE);
  const piped = values['password-stdin'];
  if (!piped && !process.stdin.isTTY) {
    throw new ToolDropError(
      'invalid_input',
      'run this in a terminal to type the password, or pipe it in with --password-stdin',
    );
  }
  if (piped && (!values.username || values.totp)) {
    throw new ToolDropError(
      'invalid_input',
      '--password-stdin needs --username, and asks no TOTP secret; add --totp in a terminal',
    );
  }

  let username = values.username;
  if (!username) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    username = (await terminal.question('Username: ')).trim();
    terminal.close();
  }
  const password = piped ? await readStdin() : await askHidden('Password (hidden): ');
  const totpSecret = values.totp
    ? (await askHidden('Authenticator secret, base32 (hidden): ')).replace(/\s+/g, '')
    : undefined;

  const { engine, close } = openEngine();
  try {
    const login = await engine.addLogin({
      site,
      username,
      password,
      ...(values.label && { label: values.label }),
      ...(totpSecret && { totp_secret: totpSecret }),
      ...(values.human && { twofa: 'human' }),
      // Codes by SMS from this sender, forwarded by your phone (tooldrop sms enable).
      ...(values.sms && { twofa: 'sms', twofa_config: { sender: values.sms } }),
      // Codes by email from this sender, read from the connected inbox (tooldrop email connect).
      ...(values.email && { twofa: 'email', twofa_config: { sender: values.email } }),
    });
    const vault = await engine.vault();
    console.log(
      `Saved login ${login.label} (${login.username}) for ${login.site}${login.twofa ? `, 2FA: ${login.twofa}` : ''}. It is sealed in the vault, whose key is in ${vault.source}.`,
    );
    return 0;
  } finally {
    await close();
  }
}

async function list(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { site: { type: 'string' } } });
  const { engine, close } = openEngine();
  try {
    const saved = await engine.listLogins(['*'], values.site);
    if (saved.length === 0) {
      console.log('No saved logins. Add one with: tooldrop logins add <site>');
      return 0;
    }
    for (const login of saved) {
      console.log(
        [login.id, login.site, login.label, login.username, login.twofa ?? 'no 2FA', login.status].join('  '),
      );
    }
    return 0;
  } finally {
    await close();
  }
}

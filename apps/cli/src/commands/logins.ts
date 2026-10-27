import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';
import { askHidden, readStdin } from '../prompt.ts';

const USAGE = `usage:
  tooldrop logins add <site> [--username name] [--label text] [--totp] [--human] [--password-stdin]
  tooldrop logins list [--site <url>]
  tooldrop logins verify <site>`;

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

/** Signs in now and keeps the session; asks for the code here when the site sends one by hand. */
async function verify(args: string[]): Promise<number> {
  const [site] = args;
  if (!site) throw new ToolDropError('invalid_input', USAGE);
  const { engine, close } = openEngine();
  try {
    const ask = async (question: { text: string }) => {
      if (!process.stdin.isTTY)
        throw new ToolDropError('invalid_input', `${question.text} Run this in a terminal.`);
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await terminal.question(`${question.text} `);
      } finally {
        terminal.close();
      }
    };
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

async function add(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      username: { type: 'string' },
      label: { type: 'string' },
      totp: { type: 'boolean', default: false },
      human: { type: 'boolean', default: false },
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

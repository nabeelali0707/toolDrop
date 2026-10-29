import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';
import { askHidden, readStdin } from '../prompt.ts';

// `tooldrop email connect`: the inbox email codes are read from (SPEC, 2FA
// step 2). The password is typed at a hidden prompt or piped in, never an
// argument, and is sealed in the vault once toolDrop has signed in with it.

const USAGE =
  'usage: tooldrop email connect <imap host> --user <address> [--port 993] [--no-tls] [--password-stdin]';

export async function email(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      user: { type: 'string' },
      port: { type: 'string', default: '993' },
      'no-tls': { type: 'boolean', default: false },
      'password-stdin': { type: 'boolean', default: false },
    },
  });
  const [command, host] = positionals;
  if (command !== 'connect' || !host) throw new ToolDropError('invalid_input', USAGE);
  const piped = values['password-stdin'];
  if (!piped && !process.stdin.isTTY) {
    throw new ToolDropError(
      'invalid_input',
      'run this in a terminal to type the password, or pipe it in with --password-stdin',
    );
  }

  let user = values.user;
  if (!user) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    user = (await terminal.question('Email address: ')).trim();
    terminal.close();
  }
  // Many providers want an app password here, not the account password.
  const password = piped
    ? (await readStdin()).trim()
    : await askHidden('Password or app password (hidden): ');

  const { engine, close } = openEngine({ backgroundHeals: false });
  try {
    const port = Number(values.port);
    const saved = await engine.connectMailbox({
      host,
      port,
      ...(values['no-tls'] && { secure: false }),
      user,
      password,
    });
    console.log(`Connected to the mailbox of ${saved.user} at ${saved.host}; it is sealed in the vault.
Logins whose codes come by email read them from it:

  tooldrop logins add <site> --email <sender address>`);
    return 0;
  } finally {
    await close();
  }
}

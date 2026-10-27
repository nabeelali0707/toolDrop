import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/** Asks for a secret in the terminal without showing what is typed. */
export async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  try {
    // The question is written first; everything typed after it stays hidden.
    const answer = terminal.question(question);
    muted = true;
    const value = await answer;
    process.stdout.write('\n');
    return value;
  } finally {
    terminal.close();
  }
}

/** Everything piped into the command, without the final newline: `--password-stdin`. */
export async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += (chunk as Buffer).toString('utf8');
  return data.replace(/\r?\n$/, '');
}

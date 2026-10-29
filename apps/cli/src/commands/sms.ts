import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { openEngine } from '../home.ts';

// `tooldrop sms`: SMS codes from your own phone (SPEC, SMS codes; DECISIONS.md,
// D-008). An open-source forwarder app posts each SMS to toolDrop's webhook,
// which `tooldrop serve` opens on this computer's local network address.

const USAGE = 'usage: tooldrop sms enable [--port 3000]';

/** This computer's address on the local network, where a phone on the same network reaches it. */
export function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
}

export async function sms(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string', default: '3000' } },
  });
  if (positionals[0] !== 'enable') throw new ToolDropError('invalid_input', USAGE);
  const { engine, close } = openEngine({ backgroundHeals: false });
  try {
    const secret = await engine.enableSms();
    const address = lanAddress() ?? "<this computer's address on your network>";
    console.log(`SMS codes are on. On your Android phone, in SMS to URL Forwarder (MIT, from F-Droid):

  Webhook URL:    http://${address}:${values.port}/v1/sms/inbound
  JSON template:  {"from":"%from%","text":"%text%","receivedStamp":"%receivedStamp%"}
  Signing:        HMAC-SHA256, with this secret:

  ${secret}

Set its sender filter so only your 2FA senders are forwarded. The phone must be on
this network, or reach it through your own VPN. Then (re)start \`tooldrop serve\`,
which opens the webhook on ${address} too, and save a login whose codes come by SMS:

  tooldrop logins add <site> --sms <sender>`);
    return 0;
  } finally {
    await close();
  }
}

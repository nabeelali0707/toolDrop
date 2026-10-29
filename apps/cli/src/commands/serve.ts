import { parseArgs } from 'node:util';
import { createApiKey, listApiKeys } from '@tooldrop/db';
import { createServer, createSmsServer } from '@tooldrop/server';
import { dashboardDir, openEngine, version } from '../home.ts';
import { lanAddress } from './sms.ts';

const HEALTH_CHECK_MS = 24 * 60 * 60_000;

/** `tooldrop serve`: the REST API and remote MCP, on loopback unless told otherwise. */
export async function serve(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string', default: '3000' }, host: { type: 'string', default: '127.0.0.1' } },
  });
  const port = Number(values.port);
  const { engine, close } = openEngine();

  // First run: make a key, since every route needs one.
  if (!listApiKeys(engine.db).some((key) => !key.revoked_at)) {
    const { key } = createApiKey(engine.db, { label: 'first key' });
    console.log(`Created your first API key. It is shown only this once:\n\n  ${key}\n`);
  }

  const dashboard = dashboardDir();
  const app = createServer({ engine, version: version(), ...(dashboard && { dashboardDir: dashboard }) });
  await app.listen({ host: values.host, port });
  const base = `http://${values.host.includes(':') ? `[${values.host}]` : values.host}:${port}`;
  console.log(`toolDrop ${version()} is listening on ${base}`);
  console.log(`  REST: ${base}/v1/tools`);
  console.log(`  MCP:  ${base}/mcp (Streamable HTTP)`);
  if (dashboard) console.log(`  Dashboard: ${base}/`);
  if (!isLoopback(values.host)) {
    console.log(
      '\nWarning: reachable from other machines. Put it behind TLS and treat API keys like passwords.',
    );
  }

  // Every day, each tool runs its saved test inputs; a failure starts a repair (SPEC, Self-healing).
  const healthCheck = setInterval(() => {
    engine.healthCheck().catch(() => undefined);
  }, HEALTH_CHECK_MS);
  healthCheck.unref();
  // Watches run while the server runs (SPEC, Watches); engine.close stops them.
  engine.watches.start();
  // SMS codes: the webhook alone, on the local network address, so a phone can reach it (D-008).
  const lan = engine.smsEnabled() && isLoopback(values.host) ? lanAddress() : undefined;
  const smsServer = lan ? createSmsServer({ engine }) : undefined;
  if (smsServer && lan) {
    await smsServer.listen({ host: lan, port });
    console.log(`  SMS webhook: http://${lan}:${port}/v1/sms/inbound (this network only)`);
  }

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(healthCheck);
  await smsServer?.close();
  await app.close();
  await close();
  return 0;
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

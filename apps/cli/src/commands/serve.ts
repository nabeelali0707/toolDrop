import { parseArgs } from 'node:util';
import { createApiKey, listApiKeys } from '@tooldrop/db';
import { createServer } from '@tooldrop/server';
import { openEngine, version } from '../home.ts';

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

  const app = createServer({ engine, version: version() });
  await app.listen({ host: values.host, port });
  const base = `http://${values.host.includes(':') ? `[${values.host}]` : values.host}:${port}`;
  console.log(`toolDrop ${version()} is listening on ${base}`);
  console.log(`  REST: ${base}/v1/tools`);
  console.log(`  MCP:  ${base}/mcp (Streamable HTTP)`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(values.host)) {
    console.log(
      '\nWarning: reachable from other machines. Put it behind TLS and treat API keys like passwords.',
    );
  }

  // Every day, each tool runs its saved test inputs; a failure starts a repair (SPEC, Self-healing).
  const healthCheck = setInterval(() => {
    engine.healthCheck().catch(() => undefined);
  }, HEALTH_CHECK_MS);
  healthCheck.unref();

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(healthCheck);
  await app.close();
  await close();
  return 0;
}

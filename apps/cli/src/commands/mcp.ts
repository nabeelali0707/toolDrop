import { serveStdio } from '@tooldrop/mcp';
import { openEngine, version } from '../home.ts';

/** `tooldrop mcp`: the MCP server over stdio. Nothing but the protocol may go to stdout. */
export async function mcp(): Promise<number> {
  const { engine, close } = openEngine();
  const server = await serveStdio(engine, { version: version() });
  await new Promise<void>((resolve) => {
    const previous = server.onclose;
    server.onclose = () => {
      previous?.();
      resolve();
    };
  });
  await close();
  return 0;
}

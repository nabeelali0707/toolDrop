import { serveStdio } from '@tooldrop/mcp';
import { openEngine, version } from '../home.ts';

/** `tooldrop mcp`: the MCP server over stdio. Nothing but the protocol may go to stdout. */
export async function mcp(): Promise<number> {
  // Builds run in this process; a library that prints would break the protocol, so logs go to stderr.
  console.log = console.info = console.debug = console.error;
  const { engine, close } = openEngine();
  const server = await serveStdio(engine, { version: version() });
  // Watches run while the client keeps toolDrop running, and report changes to it as well.
  engine.watches.start();
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

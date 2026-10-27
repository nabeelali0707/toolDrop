import { isToolDropError } from '@tooldrop/core';
import { build } from './commands/build.ts';
import { init } from './commands/init.ts';
import { keys } from './commands/keys.ts';
import { logins } from './commands/logins.ts';
import { mcp } from './commands/mcp.ts';
import { record } from './commands/record.ts';
import { run } from './commands/run.ts';
import { serve } from './commands/serve.ts';
import { tools } from './commands/tools.ts';
import { version } from './home.ts';

const HELP = `toolDrop ${version()}: turn website tasks into tools your AI agent can call.

Usage: tooldrop <command> [options]

  init                   Set up models (Ollama) and the browser for your machine
  mcp                    Run the MCP server over stdio, for Claude Desktop, Claude Code, Cursor, VS Code
  serve                  Run the REST API and remote MCP on http://127.0.0.1:3000 (--port, --host)
  run <tool>             Run a published tool (--input '{"status":"open"}')
  tools list             List published tools
  tools add <path>       Publish a tool file (with --site <url>) or a community recipe folder
  tools versions <tool>  A tool's versions and heal log
  tools rollback <tool> <version>  Make an earlier version current again
  keys create            Create an API key for REST and remote MCP (--label, --scopes a,b)
  keys list              List API keys
  keys revoke <id>       Revoke an API key
  logins add <site>      Save a login, sealed in the vault (--username, --totp, --human, --password-stdin)
  logins list            List saved logins, masked
  logins verify <site>   Sign in now and keep the session, asking for a code when needed
  build <url> --task     Build a tool for a task (--recording <id or file>, --hint)
  record <url>           Do a task once in a browser, for the most reliable builds (--task, --out)

Data lives in ~/.tooldrop; set TOOLDROP_HOME to use another folder.
Docs: https://nabeelali0707.github.io/toolDrop/`;

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  init,
  mcp,
  serve,
  run,
  tools,
  keys,
  build,
  record,
  logins,
};

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === '--version' || command === '-v') {
    console.log(version());
    return 0;
  }
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    console.log(HELP);
    return command === undefined || command === 'help' || command === '--help' || command === '-h' ? 0 : 1;
  }
  return handler(args);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors go to stderr: over stdio MCP, stdout belongs to the protocol.
    console.error(
      `error: ${isToolDropError(error) || error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  },
);

import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { createApiKey, listApiKeys, revokeApiKey } from '@tooldrop/db';
import { openEngine } from '../home.ts';

/** `tooldrop keys create | list | revoke <id>`: API keys for REST and remote MCP. */
export async function keys(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { label: { type: 'string', default: 'cli' }, scopes: { type: 'string', default: '*' } },
  });
  const [action, id] = positionals;
  const { engine, close } = openEngine();
  try {
    if (action === 'create') {
      const scopes = values.scopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      const { key } = createApiKey(engine.db, { label: values.label, scopes });
      console.log(
        `API key "${values.label}" for ${scopes.join(', ')}. It is shown only this once:\n\n  ${key}\n`,
      );
      return 0;
    }
    if (action === 'list') {
      for (const key of listApiKeys(engine.db)) {
        const state = key.revoked_at ? 'revoked' : `last used ${key.last_used_at?.toISOString() ?? 'never'}`;
        console.log(`${key.id}  ${key.label}  [${key.scopes.join(', ')}]  ${state}`);
      }
      return 0;
    }
    if (action === 'revoke' && id) {
      revokeApiKey(engine.db, id);
      console.log(`Revoked ${id}.`);
      return 0;
    }
    throw new ToolDropError(
      'invalid_input',
      'usage: tooldrop keys create [--label x] [--scopes a,b] | list | revoke <id>',
    );
  } finally {
    await close();
  }
}

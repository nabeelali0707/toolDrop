import { parseArgs } from 'node:util';
import { ToolDropError } from '@tooldrop/core';
import { createApiKey, getUser, listApiKeys, revokeApiKey } from '@tooldrop/db';
import { openEngine } from '../home.ts';

/** `tooldrop keys create | list | revoke <id>`: API keys for REST and remote MCP. */
export async function keys(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      label: { type: 'string', default: 'cli' },
      scopes: { type: 'string', default: '*' },
      user: { type: 'string' },
    },
  });
  const [action, id] = positionals;
  const { engine, close } = await openEngine();
  try {
    if (action === 'create') {
      const scopes = values.scopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      // A key of a user acts with the user's role; a key of no user acts as an admin (D-057).
      const user = values.user ? await getUser(engine.db, values.user) : undefined;
      if (values.user && !user) throw new ToolDropError('not_found', `no user ${values.user}`);
      const { key } = await createApiKey(engine.db, {
        label: values.label,
        scopes,
        ...(user && { user_id: user.id }),
      });
      console.log(
        `API key "${values.label}" for ${scopes.join(', ')}. It is shown only this once:\n\n  ${key}\n`,
      );
      return 0;
    }
    if (action === 'list') {
      for (const key of await listApiKeys(engine.db)) {
        const state = key.revoked_at ? 'revoked' : `last used ${key.last_used_at?.toISOString() ?? 'never'}`;
        console.log(
          `${key.id}  ${key.label}  ${key.user ? `user ${key.user}` : 'admin'}  [${key.scopes.join(', ')}]  ${state}`,
        );
      }
      return 0;
    }
    if (action === 'revoke' && id) {
      await revokeApiKey(engine.db, id);
      console.log(`Revoked ${id}.`);
      return 0;
    }
    throw new ToolDropError(
      'invalid_input',
      'usage: tooldrop keys create [--label x] [--scopes a,b] [--user <name>] | list | revoke <id>',
    );
  } finally {
    await close();
  }
}

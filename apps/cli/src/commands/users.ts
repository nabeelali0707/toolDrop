import { parseArgs } from 'node:util';
import { roleSchema, ToolDropError } from '@tooldrop/core';
import { createApiKey, createUser, deleteUser, listAudit, listUsers, setUserRole } from '@tooldrop/db';
import { openEngine } from '../home.ts';

// `tooldrop users` and `tooldrop audit`: the people who use a self-hosted
// toolDrop, their roles, and the log of what they changed (D-057). Run inside
// the container: docker compose exec app tooldrop users add alice --role editor

const USERS_USAGE = `usage:
  tooldrop users add <name> [--role viewer|editor|admin] [--scopes a,b]
  tooldrop users list
  tooldrop users role <name> <viewer|editor|admin>
  tooldrop users remove <name>`;

export async function users(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { role: { type: 'string', default: 'editor' }, scopes: { type: 'string', default: '*' } },
  });
  const [action = 'list', name, role] = positionals;
  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    const db = engine.db;
    if (action === 'list') {
      const all = await listUsers(db);
      if (all.length === 0)
        console.log('No users yet: keys of no user act as admins. Add one with `tooldrop users add`.');
      for (const user of all)
        console.log(`${user.name}  ${user.role}  since ${user.created_at.toISOString()}`);
      return 0;
    }
    if (!name) throw new ToolDropError('invalid_input', USERS_USAGE);
    if (action === 'add') {
      const parsedRole = roleSchema.safeParse(values.role);
      if (!parsedRole.success)
        throw new ToolDropError('invalid_input', 'the role is viewer, editor or admin');
      const user = await createUser(db, { name, role: parsedRole.data });
      const scopes = values.scopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      const { key } = await createApiKey(db, { label: name, scopes, user_id: user.id });
      console.log(`Added ${name}, ${user.role}. Their API key is shown only this once:\n\n  ${key}\n`);
      return 0;
    }
    if (action === 'role') {
      const parsedRole = roleSchema.safeParse(role);
      if (!parsedRole.success) throw new ToolDropError('invalid_input', USERS_USAGE);
      await setUserRole(db, name, parsedRole.data);
      console.log(`${name} is now ${parsedRole.data}.`);
      return 0;
    }
    if (action === 'remove') {
      if (!(await deleteUser(db, name))) throw new ToolDropError('not_found', `no user ${name}`);
      console.log(`Removed ${name} and their API keys.`);
      return 0;
    }
    throw new ToolDropError('invalid_input', USERS_USAGE);
  } finally {
    await close();
  }
}

export async function audit(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { limit: { type: 'string', default: '50' }, actor: { type: 'string' } },
  });
  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    const events = await listAudit(engine.db, {
      limit: Math.min(500, Math.max(1, Number(values.limit) || 50)),
      ...(values.actor && { actor: values.actor }),
    });
    if (events.length === 0)
      console.log('Nothing in the audit log yet: it records changes made over the API.');
    for (const event of events) {
      console.log(
        `${event.created_at.toISOString()}  ${event.actor}  ${event.action}${event.target ? ` ${event.target}` : ''}  ${event.status ?? ''}`,
      );
    }
    return 0;
  } finally {
    await close();
  }
}

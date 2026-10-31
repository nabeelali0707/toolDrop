import { isToolDropError, type Recipe, type ToolDefinition } from '@tooldrop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../client.ts';
import { DIALECTS, openTestDatabase } from '../testing.ts';
import {
  createApiKey,
  createUser,
  deleteUser,
  listAudit,
  recordAudit,
  setUserRole,
  findTools,
  getTool,
  keyAllows,
  listTools,
  publishTool,
  listVersions,
  recordRun,
  revokeApiKey,
  rollbackTool,
  verifyApiKey,
} from './index.ts';

const definition: ToolDefinition = {
  name: 'list_invoices',
  description: 'List supplier invoices by status and date.',
  authority: 'read',
  input_schema: { type: 'object', properties: { status: { type: 'string' } } },
  output_schema: { type: 'array' },
};

const recipe: Recipe = {
  strategy: 'http_replay',
  steps: [{ op: 'http', method: 'GET', url: '{{site}}/api/invoices' }],
  fallback: { strategy: 'browser_script', steps: [{ op: 'goto', url: '{{site}}/invoices' }] },
};

describe.each(DIALECTS)('on %s', (dialect) => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await openTestDatabase(dialect);
  });

  afterEach(() => handle.close());

  const publish = (change: Partial<{ site: string; definition: ToolDefinition }> = {}) =>
    publishTool(handle.db, {
      site: change.site ?? 'http://127.0.0.1:4101/some/page',
      definition: change.definition ?? definition,
      recipe,
      created_by: 'user',
    });

  describe('tools', () => {
    it('publishes version 1, with its site and fallback', async () => {
      const tool = await publish();
      expect(tool).toMatchObject({ name: 'list_invoices', version: 1, status: 'live', recipe });
      expect(tool.site).toMatchObject({
        origin: 'http://127.0.0.1:4101',
        rate_limit: { per_second: 1, concurrency: 2 },
      });
      expect(await getTool(handle.db, 'list_invoices')).toEqual(tool);
    });

    it('publishes the next version and keeps serving the newest', async () => {
      await publish();
      const v2 = await publish({ definition: { ...definition, description: 'Version two.' } });
      expect(v2.version).toBe(2);
      expect((await getTool(handle.db, 'list_invoices'))?.description).toBe('Version two.');
      expect(await listTools(handle.db)).toHaveLength(1);
    });

    it('rolls back to an earlier version exactly, and keeps numbering from the newest', async () => {
      const v1 = await publish();
      const healed = await publishTool(handle.db, {
        site: 'http://127.0.0.1:4101',
        definition,
        recipe: { ...recipe, steps: [{ op: 'http', method: 'GET', url: '{{site}}/api/v3/invoices' }] },
        created_by: 'heal',
        change_reason: 'The API moved to /api/v3',
      });
      expect(healed.version).toBe(2);

      const back = await rollbackTool(handle.db, 'list_invoices', 1);
      expect(back.version).toBe(1);
      expect(back.recipe).toEqual(v1.recipe);
      expect(await listVersions(handle.db, 'list_invoices')).toMatchObject([
        { version: 1, created_by: 'user', current: true },
        { version: 2, created_by: 'heal', change_reason: 'The API moved to /api/v3', current: false },
      ]);
      expect((await publish()).version).toBe(3);
      await expect(rollbackTool(handle.db, 'list_invoices', 9)).rejects.toThrow(/no version 9/);
    });

    it('will not let another site take a tool name, and leaves the database as it was', async () => {
      await publish();
      const error: unknown = await publish({ site: 'http://127.0.0.1:4102' }).catch(
        (caught: unknown) => caught,
      );
      expect(isToolDropError(error, 'invalid_input')).toBe(true);
      expect((await listTools(handle.db)).map((tool) => tool.site.origin)).toEqual(['http://127.0.0.1:4101']);
    });

    it('publishes one version at a time when publishes overlap', async () => {
      await publish();
      const versions = await Promise.all([publish(), publish(), publish()]);
      expect(versions.map((tool) => tool.version).sort()).toEqual([2, 3, 4]);
    });

    it('finds tools by the words of a task and by site', async () => {
      await publish();
      await publish({
        site: 'http://127.0.0.1:4104',
        definition: { ...definition, name: 'list_orders', description: 'List shop orders.' },
      });
      expect((await findTools(handle.db, { task: 'show my invoices' })).map((tool) => tool.name)).toEqual([
        'list_invoices',
      ]);
      expect((await findTools(handle.db, { site: '4104' })).map((tool) => tool.name)).toEqual([
        'list_orders',
      ]);
      expect(await findTools(handle.db, { task: 'weather forecast' })).toEqual([]);
    });

    it('records runs', async () => {
      const tool = await publish();
      const id = await recordRun(handle.db, {
        tool_id: tool.id,
        recipe_version: 1,
        strategy_used: 'browser_script',
        duration_ms: 3100,
        ok: true,
      });
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
    });
  });

  describe('API keys', () => {
    it('verifies a key, which is shown only once', async () => {
      const { key } = await createApiKey(handle.db, { label: 'laptop' });
      expect(key).toMatch(/^td_/);
      expect(await verifyApiKey(handle.db, key)).toMatchObject({ label: 'laptop', scopes: ['*'] });
      expect(await verifyApiKey(handle.db, `${key}x`)).toBeUndefined();
    });

    it('knows whose a key is and what role they have; a key of no user has no user', async () => {
      const alice = await createUser(handle.db, { name: 'alice', role: 'editor' });
      await expect(createUser(handle.db, { name: 'alice', role: 'viewer' })).rejects.toThrow(
        'already a user',
      );
      const { key } = await createApiKey(handle.db, { label: 'alice laptop', user_id: alice.id });
      expect(await verifyApiKey(handle.db, key)).toMatchObject({ user: { name: 'alice', role: 'editor' } });
      await setUserRole(handle.db, 'alice', 'viewer');
      expect(await verifyApiKey(handle.db, key)).toMatchObject({ user: { role: 'viewer' } });
      const { key: legacy } = await createApiKey(handle.db, { label: 'before users' });
      expect(await verifyApiKey(handle.db, legacy)).toMatchObject({ user: null });

      // Removing a user removes their keys.
      expect(await deleteUser(handle.db, 'alice')).toBe(true);
      expect(await verifyApiKey(handle.db, key)).toBeUndefined();
      expect(await deleteUser(handle.db, 'alice')).toBe(false);
    });

    it('keeps an audit log, newest first', async () => {
      await recordAudit(handle.db, { actor: 'user:alice', action: 'POST /v1/builds', status: 202 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await recordAudit(handle.db, {
        actor: 'user:bob',
        action: 'POST /v1/tools/:name/rollback',
        target: 'list_invoices',
        status: 200,
      });
      expect(await listAudit(handle.db)).toMatchObject([
        { actor: 'user:bob', target: 'list_invoices' },
        { actor: 'user:alice', target: null, status: 202 },
      ]);
      expect(await listAudit(handle.db, { actor: 'user:alice' })).toHaveLength(1);
    });

    it('stops accepting a revoked key', async () => {
      const { id, key } = await createApiKey(handle.db, { label: 'old' });
      await revokeApiKey(handle.db, id);
      expect(await verifyApiKey(handle.db, key)).toBeUndefined();
    });
  });
});

describe('API key scopes', () => {
  it('limits a key to its scopes', () => {
    expect(keyAllows(['*'], 'anything')).toBe(true);
    expect(keyAllows(['list_invoices'], 'list_invoices')).toBe(true);
    expect(keyAllows(['list_invoices'], 'list_orders')).toBe(false);
  });
});

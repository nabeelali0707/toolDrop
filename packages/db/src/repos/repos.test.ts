import { isToolDropError, type Recipe, type ToolDefinition } from '@tooldrop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../client.ts';
import { runMigrations } from '../migrate.ts';
import {
  createApiKey,
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

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase(':memory:');
  runMigrations(handle.db);
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
  it('publishes version 1, with its site and fallback', () => {
    const tool = publish();
    expect(tool).toMatchObject({ name: 'list_invoices', version: 1, status: 'live', recipe });
    expect(tool.site).toMatchObject({
      origin: 'http://127.0.0.1:4101',
      rate_limit: { per_second: 1, concurrency: 2 },
    });
    expect(getTool(handle.db, 'list_invoices')).toEqual(tool);
  });

  it('publishes the next version and keeps serving the newest', () => {
    publish();
    const v2 = publish({ definition: { ...definition, description: 'Version two.' } });
    expect(v2.version).toBe(2);
    expect(getTool(handle.db, 'list_invoices')?.description).toBe('Version two.');
    expect(listTools(handle.db)).toHaveLength(1);
  });

  it('rolls back to an earlier version exactly, and keeps numbering from the newest', () => {
    const v1 = publish();
    const healed = publishTool(handle.db, {
      site: 'http://127.0.0.1:4101',
      definition,
      recipe: { ...recipe, steps: [{ op: 'http', method: 'GET', url: '{{site}}/api/v3/invoices' }] },
      created_by: 'heal',
      change_reason: 'The API moved to /api/v3',
    });
    expect(healed.version).toBe(2);

    const back = rollbackTool(handle.db, 'list_invoices', 1);
    expect(back.version).toBe(1);
    expect(back.recipe).toEqual(v1.recipe);
    expect(listVersions(handle.db, 'list_invoices')).toMatchObject([
      { version: 1, created_by: 'user', current: true },
      { version: 2, created_by: 'heal', change_reason: 'The API moved to /api/v3', current: false },
    ]);
    expect(publish().version).toBe(3);
    expect(() => rollbackTool(handle.db, 'list_invoices', 9)).toThrow(/no version 9/);
  });

  it('will not let another site take a tool name', () => {
    publish();
    try {
      publish({ site: 'http://127.0.0.1:4102' });
      expect.unreachable();
    } catch (error) {
      expect(isToolDropError(error, 'invalid_input')).toBe(true);
    }
  });

  it('finds tools by the words of a task and by site', () => {
    publish();
    publish({
      site: 'http://127.0.0.1:4104',
      definition: { ...definition, name: 'list_orders', description: 'List shop orders.' },
    });
    expect(findTools(handle.db, { task: 'show my invoices' }).map((tool) => tool.name)).toEqual([
      'list_invoices',
    ]);
    expect(findTools(handle.db, { site: '4104' }).map((tool) => tool.name)).toEqual(['list_orders']);
    expect(findTools(handle.db, { task: 'weather forecast' })).toEqual([]);
  });

  it('records runs', () => {
    const tool = publish();
    const id = recordRun(handle.db, {
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
  it('verifies a key, which is shown only once', () => {
    const { key } = createApiKey(handle.db, { label: 'laptop' });
    expect(key).toMatch(/^td_/);
    expect(verifyApiKey(handle.db, key)).toMatchObject({ label: 'laptop', scopes: ['*'] });
    expect(verifyApiKey(handle.db, `${key}x`)).toBeUndefined();
  });

  it('stops accepting a revoked key', () => {
    const { id, key } = createApiKey(handle.db, { label: 'old' });
    revokeApiKey(handle.db, id);
    expect(verifyApiKey(handle.db, key)).toBeUndefined();
  });

  it('limits a key to its scopes', () => {
    expect(keyAllows(['*'], 'anything')).toBe(true);
    expect(keyAllows(['list_invoices'], 'list_invoices')).toBe(true);
    expect(keyAllows(['list_invoices'], 'list_orders')).toBe(false);
  });
});

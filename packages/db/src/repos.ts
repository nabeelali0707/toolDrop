import { createHash, randomBytes } from 'node:crypto';
import {
  newId,
  ToolDropError,
  type Recipe,
  type RecipeOrigin,
  type Strategy,
  type ToolDefinition,
  type ToolStatus,
} from '@tooldrop/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Queryable } from './client.ts';
import { api_keys, recipe_versions, runs, sites, tools, type RateLimit } from './schema.ts';

// The queries the servers need. better-sqlite3 is synchronous, so these are too.

export type SiteRow = typeof sites.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;

/** A tool as callers see it, with its live recipe and site. */
export interface PublishedTool {
  id: string;
  name: string;
  description: string;
  authority: ToolRow['authority'];
  input_schema: ToolRow['input_schema'];
  output_schema: ToolRow['output_schema'];
  status: ToolStatus;
  version: number;
  recipe: Recipe;
  site: { id: string; origin: string; rate_limit: RateLimit };
}

/** The site for an origin, created on first use. */
export function ensureSite(db: Queryable, origin: string): SiteRow {
  const normalized = new URL(origin).origin;
  const existing = db.select().from(sites).where(eq(sites.origin, normalized)).get();
  if (existing) return existing;
  return db
    .insert(sites)
    .values({ id: newId(), origin: normalized, name: new URL(normalized).host })
    .returning()
    .get();
}

export interface PublishInput {
  site: string;
  definition: ToolDefinition;
  recipe: Recipe;
  test_inputs?: Record<string, unknown>[];
  created_by: RecipeOrigin;
  change_reason?: string;
}

/**
 * Publishes a tool: version 1 for a new name, the next version for an
 * existing one. Earlier versions stay for rollback.
 */
export function publishTool(db: Queryable, input: PublishInput): PublishedTool {
  return db.transaction((tx) => {
    const site = ensureSite(tx, input.site);
    const { definition, recipe } = input;
    const existing = tx.select().from(tools).where(eq(tools.name, definition.name)).get();
    if (existing && existing.site_id !== site.id) {
      throw new ToolDropError(
        'invalid_input',
        `a tool named ${definition.name} already exists for another site`,
      );
    }

    const version = (existing?.current_version ?? 0) + 1;
    const fields = {
      description: definition.description,
      authority: definition.authority,
      input_schema: definition.input_schema,
      output_schema: definition.output_schema,
      current_version: version,
      status: 'live' as const,
    };
    const toolId = existing?.id ?? newId();
    if (existing) {
      tx.update(tools).set(fields).where(eq(tools.id, toolId)).run();
    } else {
      tx.insert(tools)
        .values({ id: toolId, site_id: site.id, name: definition.name, ...fields })
        .run();
    }
    tx.insert(recipe_versions)
      .values({
        id: newId(),
        tool_id: toolId,
        version,
        strategy: recipe.strategy,
        steps: recipe.steps,
        fallback: recipe.fallback ?? null,
        test_inputs: input.test_inputs ?? [],
        created_by: input.created_by,
        change_reason: input.change_reason ?? null,
      })
      .run();

    const published = getTool(tx, definition.name);
    if (!published) throw new ToolDropError('internal', `${definition.name} vanished while publishing`);
    return published;
  });
}

/** A tool by name, with its live recipe, or undefined. */
export function getTool(db: Queryable, name: string): PublishedTool | undefined {
  return queryTools(db, eq(tools.name, name))[0];
}

/** Tools callers can use, newest first. */
export function listTools(db: Queryable, options: { status?: ToolStatus } = {}): PublishedTool[] {
  return queryTools(db, eq(tools.status, options.status ?? 'live'));
}

/**
 * Tools that may already do a task (SPEC, build step 1): matched by site and
 * by the words of the task in the tool's name and description.
 */
export function findTools(db: Queryable, query: { site?: string; task?: string }): PublishedTool[] {
  const words = (query.task ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  const site = query.site?.toLowerCase();
  return listTools(db)
    .filter((tool) => !site || tool.site.origin.toLowerCase().includes(site))
    .map((tool) => {
      const text = `${tool.name.replaceAll('_', ' ')} ${tool.description}`.toLowerCase();
      return { tool, score: words.filter((word) => text.includes(word)).length };
    })
    .filter(({ score }) => words.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ tool }) => tool);
}

export interface RunRecord {
  tool_id: string;
  recipe_version: number;
  strategy_used: Strategy;
  duration_ms: number;
  ok: boolean;
  error_code?: string | null;
  healed?: boolean;
}

/** Logs how a call went. Results are never stored (SPEC, Performance rules). */
export function recordRun(db: Queryable, run: RunRecord): string {
  const id = newId();
  db.insert(runs)
    .values({ id, ...run, error_code: run.error_code ?? null, healed: run.healed ?? false })
    .run();
  return id;
}

function queryTools(db: Queryable, where: ReturnType<typeof eq>): PublishedTool[] {
  return db
    .select({ tool: tools, recipe: recipe_versions, site: sites })
    .from(tools)
    .innerJoin(
      recipe_versions,
      and(eq(recipe_versions.tool_id, tools.id), eq(recipe_versions.version, tools.current_version)),
    )
    .innerJoin(sites, eq(sites.id, tools.site_id))
    .where(where)
    .orderBy(desc(tools.updated_at))
    .all()
    .map(({ tool, recipe, site }) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      authority: tool.authority,
      input_schema: tool.input_schema,
      output_schema: tool.output_schema,
      status: tool.status,
      version: recipe.version,
      recipe: {
        strategy: recipe.strategy,
        steps: recipe.steps,
        ...(recipe.fallback && { fallback: recipe.fallback }),
      },
      site: { id: site.id, origin: site.origin, rate_limit: site.rate_limit },
    }));
}

// API keys (DECISIONS.md, D-021).

const KEY_PREFIX = 'td_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Creates a key. The returned `key` is the only time it is ever shown. */
export function createApiKey(
  db: Queryable,
  options: { label: string; scopes?: string[] },
): { id: string; key: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const id = newId();
  db.insert(api_keys)
    .values({ id, label: options.label, key_hash: hashApiKey(key), scopes: options.scopes ?? ['*'] })
    .run();
  return { id, key };
}

/** The key's record when it is valid and not revoked. */
export function verifyApiKey(
  db: Queryable,
  key: string,
): { id: string; label: string; scopes: string[] } | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const row = db
    .select()
    .from(api_keys)
    .where(and(eq(api_keys.key_hash, hashApiKey(key)), isNull(api_keys.revoked_at)))
    .get();
  if (!row) return undefined;
  db.update(api_keys).set({ last_used_at: new Date() }).where(eq(api_keys.id, row.id)).run();
  return { id: row.id, label: row.label, scopes: row.scopes };
}

export function revokeApiKey(db: Queryable, id: string): void {
  db.update(api_keys).set({ revoked_at: new Date() }).where(eq(api_keys.id, id)).run();
}

/** Whether a key's scopes allow running a tool. */
export function keyAllows(scopes: string[], toolName: string): boolean {
  return scopes.includes('*') || scopes.includes(toolName);
}

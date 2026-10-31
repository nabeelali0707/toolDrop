import {
  newId,
  ToolDropError,
  type Recipe,
  type RecipeOrigin,
  type Strategy,
  type ToolDefinition,
  type ToolStatus,
} from '@tooldrop/core';
import { and, asc, desc, eq, max, ne, type SQL } from 'drizzle-orm';
import { first, lockKey, one, tablesOf, transaction, type Queryable } from '../client.ts';
import type { RateLimit, runs, sites, tools } from '../schema.ts';

// The queries the servers need, for SQLite and Postgres alike (client.ts).

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
export async function ensureSite(db: Queryable, origin: string): Promise<SiteRow> {
  const { sites } = tablesOf(db);
  const normalized = new URL(origin).origin;
  const bySite = eq(sites.origin, normalized);
  const existing = first(await db.select().from(sites).where(bySite));
  if (existing) return existing;
  // Another request may create the same site in between; then its row is the one.
  const created = first(
    await db
      .insert(sites)
      .values({ id: newId(), origin: normalized, name: new URL(normalized).host })
      .onConflictDoNothing({ target: sites.origin })
      .returning(),
  );
  return created ?? one(await db.select().from(sites).where(bySite));
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
export function publishTool(db: Queryable, input: PublishInput): Promise<PublishedTool> {
  return transaction(db, async (tx) => {
    const { recipe_versions, tools } = tablesOf(tx);
    const { definition, recipe } = input;
    await lockKey(tx, `tool:${definition.name}`);
    const site = await ensureSite(tx, input.site);
    const existing = first(await tx.select().from(tools).where(eq(tools.name, definition.name)));
    if (existing && existing.site_id !== site.id) {
      throw new ToolDropError(
        'invalid_input',
        `a tool named ${definition.name} already exists for another site`,
      );
    }

    // After a rollback the current version is not the newest, so numbering continues from the newest.
    const newest = existing
      ? first(
          await tx
            .select({ version: max(recipe_versions.version) })
            .from(recipe_versions)
            .where(eq(recipe_versions.tool_id, existing.id)),
        )?.version
      : undefined;
    const version = (newest ?? 0) + 1;
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
      await tx.update(tools).set(fields).where(eq(tools.id, toolId));
    } else {
      await tx.insert(tools).values({ id: toolId, site_id: site.id, name: definition.name, ...fields });
    }
    await tx.insert(recipe_versions).values({
      id: newId(),
      tool_id: toolId,
      version,
      strategy: recipe.strategy,
      steps: recipe.steps,
      fallback: recipe.fallback ?? null,
      test_inputs: input.test_inputs ?? [],
      created_by: input.created_by,
      change_reason: input.change_reason ?? null,
    });

    const published = await getTool(tx, definition.name);
    if (!published) throw new ToolDropError('internal', `${definition.name} vanished while publishing`);
    return published;
  });
}

export interface VersionSummary {
  version: number;
  strategy: Strategy;
  created_by: RecipeOrigin;
  change_reason: string | null;
  created_at: string;
  current: boolean;
}

/** Every version of a tool, oldest first: its history and heal log (SPEC, Rollback). */
export async function listVersions(db: Queryable, name: string): Promise<VersionSummary[]> {
  const { recipe_versions, tools } = tablesOf(db);
  const tool = first(await db.select().from(tools).where(eq(tools.name, name)));
  if (!tool) throw new ToolDropError('not_found', `no tool named ${name}`);
  const rows = await db
    .select()
    .from(recipe_versions)
    .where(eq(recipe_versions.tool_id, tool.id))
    .orderBy(asc(recipe_versions.version));
  return rows.map((row) => ({
    version: row.version,
    strategy: row.strategy,
    created_by: row.created_by,
    change_reason: row.change_reason,
    created_at: row.created_at.toISOString(),
    current: row.version === tool.current_version,
  }));
}

/** Makes an earlier version current again, exactly as it was. Later versions stay in the history. */
export async function rollbackTool(db: Queryable, name: string, version: number): Promise<PublishedTool> {
  const { recipe_versions, tools } = tablesOf(db);
  const tool = first(await db.select().from(tools).where(eq(tools.name, name)));
  if (!tool) throw new ToolDropError('not_found', `no tool named ${name}`);
  const row = first(
    await db
      .select({ id: recipe_versions.id })
      .from(recipe_versions)
      .where(and(eq(recipe_versions.tool_id, tool.id), eq(recipe_versions.version, version))),
  );
  if (!row) throw new ToolDropError('not_found', `${name} has no version ${version}`);
  await db.update(tools).set({ current_version: version, status: 'live' }).where(eq(tools.id, tool.id));
  const published = await getTool(db, name);
  if (!published) throw new ToolDropError('internal', `${name} vanished during the rollback`);
  return published;
}

/** Marks a tool's state, e.g. `degraded` after a heal that failed (SPEC, Self-healing). */
export async function setToolStatus(db: Queryable, name: string, status: ToolStatus): Promise<void> {
  const { tools } = tablesOf(db);
  await db.update(tools).set({ status }).where(eq(tools.name, name));
}

/** The input sets a version was validated with, for health checks and heals. */
export async function testInputs(
  db: Queryable,
  toolId: string,
  version: number,
): Promise<Record<string, unknown>[]> {
  const { recipe_versions } = tablesOf(db);
  const row = first(
    await db
      .select({ inputs: recipe_versions.test_inputs })
      .from(recipe_versions)
      .where(and(eq(recipe_versions.tool_id, toolId), eq(recipe_versions.version, version))),
  );
  return row?.inputs ?? [];
}

/** A tool by name, with its live recipe, or undefined. */
export async function getTool(db: Queryable, name: string): Promise<PublishedTool | undefined> {
  return first(await queryTools(db, eq(tablesOf(db).tools.name, name)));
}

/**
 * Tools callers can use, newest first: live ones, and degraded ones, which
 * may still work for some inputs. Disabled tools are left out.
 */
export function listTools(db: Queryable, options: { status?: ToolStatus } = {}): Promise<PublishedTool[]> {
  const { tools } = tablesOf(db);
  return queryTools(db, options.status ? eq(tools.status, options.status) : ne(tools.status, 'disabled'));
}

/**
 * Tools that may already do a task (SPEC, build step 1): matched by site and
 * by the words of the task in the tool's name and description.
 */
export async function findTools(
  db: Queryable,
  query: { site?: string; task?: string },
): Promise<PublishedTool[]> {
  const words = (query.task ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  const site = query.site?.toLowerCase();
  return (await listTools(db))
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
  /** The heal the call waited on (DECISIONS.md, D-013). */
  heal_job_id?: string | null;
}

export type RunRow = typeof runs.$inferSelect;

/** Recent runs, newest first, with the name of the tool each ran; optionally one tool's only. */
export async function listRuns(
  db: Queryable,
  options: { tool?: string; limit?: number } = {},
): Promise<(RunRow & { tool: string })[]> {
  const { runs, tools } = tablesOf(db);
  const rows = await db
    .select({ run: runs, tool: tools.name })
    .from(runs)
    .innerJoin(tools, eq(tools.id, runs.tool_id))
    .where(options.tool ? eq(tools.name, options.tool) : undefined)
    .orderBy(desc(runs.created_at))
    .limit(options.limit ?? 50);
  return rows.map(({ run, tool }) => ({ ...run, tool }));
}

/** Logs how a call went. Results are never stored (SPEC, Performance rules). */
export async function recordRun(db: Queryable, run: RunRecord): Promise<string> {
  const { runs } = tablesOf(db);
  const id = newId();
  await db.insert(runs).values({
    id,
    ...run,
    error_code: run.error_code ?? null,
    healed: run.healed ?? false,
    heal_job_id: run.heal_job_id ?? null,
  });
  return id;
}

async function queryTools(db: Queryable, where: SQL): Promise<PublishedTool[]> {
  const { recipe_versions, sites, tools } = tablesOf(db);
  const rows = await db
    .select({ tool: tools, recipe: recipe_versions, site: sites })
    .from(tools)
    .innerJoin(
      recipe_versions,
      and(eq(recipe_versions.tool_id, tools.id), eq(recipe_versions.version, tools.current_version)),
    )
    .innerJoin(sites, eq(sites.id, tools.site_id))
    .where(where)
    .orderBy(desc(tools.updated_at));
  return rows.map(({ tool, recipe, site }) => ({
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

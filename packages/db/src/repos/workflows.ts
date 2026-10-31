import { newId, type Authority, type JsonSchema, type WorkflowStep } from '@tooldrop/core';
import { asc, eq } from 'drizzle-orm';
import { first, one, tablesOf, type Queryable } from '../client.ts';
import type { workflows } from '../schema.ts';

// Multi-site workflows (SPEC, Differentiating features): tools chained into
// one. The engine checks a workflow before it is saved and runs it as a job.

export type WorkflowRow = typeof workflows.$inferSelect;

/** Saves a workflow under its name: a new one, or a new definition for the one there is. */
export async function saveWorkflow(
  db: Queryable,
  workflow: {
    name: string;
    description: string;
    authority: Authority;
    input_schema: JsonSchema;
    steps: WorkflowStep[];
    output?: unknown;
  },
): Promise<WorkflowRow> {
  const { workflows } = tablesOf(db);
  const fields = {
    description: workflow.description,
    authority: workflow.authority,
    input_schema: workflow.input_schema,
    steps: workflow.steps,
    output: workflow.output ?? null,
  };
  const existing = await getWorkflow(db, workflow.name);
  if (existing) {
    return one(await db.update(workflows).set(fields).where(eq(workflows.id, existing.id)).returning());
  }
  return one(
    await db
      .insert(workflows)
      .values({ id: newId(), name: workflow.name, ...fields })
      .returning(),
  );
}

export async function getWorkflow(db: Queryable, name: string): Promise<WorkflowRow | undefined> {
  const { workflows } = tablesOf(db);
  return first(await db.select().from(workflows).where(eq(workflows.name, name)));
}

/** By name. */
export async function listWorkflows(db: Queryable): Promise<WorkflowRow[]> {
  const { workflows } = tablesOf(db);
  const rows = await db.select().from(workflows).orderBy(asc(workflows.name));
  return rows;
}

export async function deleteWorkflow(db: Queryable, name: string): Promise<boolean> {
  const { workflows } = tablesOf(db);
  const deleted = await db.delete(workflows).where(eq(workflows.name, name)).returning({ id: workflows.id });
  return deleted.length > 0;
}

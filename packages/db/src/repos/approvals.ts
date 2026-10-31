import { newId, type ApprovalStatus } from '@tooldrop/core';
import { and, desc, eq } from 'drizzle-orm';
import { first, one, tablesOf, type Queryable } from '../client.ts';
import type { approval_policies, approvals } from '../schema.ts';

// Safe mode (SPEC, Differentiating features): writes waiting for a decision,
// the record of each decision and its outcome, and the policies that approve
// writes by themselves.

export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalWithTool = ApprovalRow & { tool: string };
export type PolicyRow = typeof approval_policies.$inferSelect;
export type PolicyWithTool = PolicyRow & { tool: string };

export async function createApproval(
  db: Queryable,
  approval: Pick<
    ApprovalRow,
    'id' | 'tool_id' | 'version' | 'inputs' | 'preview' | 'screenshot_path' | 'expires_at'
  >,
): Promise<ApprovalRow> {
  const { approvals } = tablesOf(db);
  return one(await db.insert(approvals).values(approval).returning());
}

function selectApprovals(db: Queryable) {
  const { approvals, tools } = tablesOf(db);
  return db
    .select({ approval: approvals, tool: tools.name })
    .from(approvals)
    .innerJoin(tools, eq(tools.id, approvals.tool_id));
}

export async function getApproval(db: Queryable, id: string): Promise<ApprovalWithTool | undefined> {
  const { approvals } = tablesOf(db);
  const found = first(await selectApprovals(db).where(eq(approvals.id, id)));
  return found && { ...found.approval, tool: found.tool };
}

/** Newest first. */
export async function listApprovals(
  db: Queryable,
  options: { status?: ApprovalStatus; limit?: number } = {},
): Promise<ApprovalWithTool[]> {
  const { approvals } = tablesOf(db);
  const rows = await selectApprovals(db)
    .where(options.status ? eq(approvals.status, options.status) : undefined)
    .orderBy(desc(approvals.created_at))
    .limit(options.limit ?? 100);
  return rows.map(({ approval, tool }) => ({ ...approval, tool }));
}

/**
 * Approves or rejects a pending approval. One UPDATE that only matches a
 * pending row, so of two decisions made at once only the first counts.
 * Undefined when the approval was not pending.
 */
export async function decideApproval(
  db: Queryable,
  id: string,
  decision: { status: 'approved' | 'rejected'; decided_by: string; decided_at: Date },
): Promise<ApprovalRow | undefined> {
  const { approvals } = tablesOf(db);
  return first(
    await db
      .update(approvals)
      .set(decision)
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .returning(),
  );
}

/** Records how an approved write went. */
export async function finishApproval(
  db: Queryable,
  id: string,
  done: Pick<ApprovalRow, 'run_id' | 'outcome' | 'after_screenshot_path'>,
): Promise<void> {
  const { approvals } = tablesOf(db);
  await db.update(approvals).set(done).where(eq(approvals.id, id));
}

export async function createPolicy(
  db: Queryable,
  policy: Pick<PolicyRow, 'tool_id' | 'field' | 'op' | 'value'>,
): Promise<PolicyRow> {
  const { approval_policies } = tablesOf(db);
  return one(
    await db
      .insert(approval_policies)
      .values({ id: newId(), ...policy })
      .returning(),
  );
}

export async function listPolicies(
  db: Queryable,
  options: { tool_id?: string } = {},
): Promise<PolicyWithTool[]> {
  const { approval_policies, tools } = tablesOf(db);
  const rows = await db
    .select({ policy: approval_policies, tool: tools.name })
    .from(approval_policies)
    .innerJoin(tools, eq(tools.id, approval_policies.tool_id))
    .where(options.tool_id ? eq(approval_policies.tool_id, options.tool_id) : undefined)
    .orderBy(approval_policies.created_at);
  return rows.map(({ policy, tool }) => ({ ...policy, tool }));
}

export async function deletePolicy(db: Queryable, id: string): Promise<boolean> {
  const { approval_policies } = tablesOf(db);
  const deleted = await db
    .delete(approval_policies)
    .where(eq(approval_policies.id, id))
    .returning({ id: approval_policies.id });
  return deleted.length > 0;
}

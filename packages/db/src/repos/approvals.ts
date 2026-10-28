import { newId, type ApprovalStatus } from '@tooldrop/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { approval_policies, approvals, tools } from '../schema.ts';

// Safe mode (SPEC, Differentiating features): writes waiting for a decision,
// the record of each decision and its outcome, and the policies that approve
// writes by themselves.

export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalWithTool = ApprovalRow & { tool: string };
export type PolicyRow = typeof approval_policies.$inferSelect;
export type PolicyWithTool = PolicyRow & { tool: string };

export function createApproval(
  db: Queryable,
  approval: Pick<
    ApprovalRow,
    'id' | 'tool_id' | 'version' | 'inputs' | 'preview' | 'screenshot_path' | 'expires_at'
  >,
): ApprovalRow {
  return db.insert(approvals).values(approval).returning().get();
}

function selectApprovals(db: Queryable) {
  return db
    .select({ approval: approvals, tool: tools.name })
    .from(approvals)
    .innerJoin(tools, eq(tools.id, approvals.tool_id));
}

export function getApproval(db: Queryable, id: string): ApprovalWithTool | undefined {
  const found = selectApprovals(db).where(eq(approvals.id, id)).get();
  return found && { ...found.approval, tool: found.tool };
}

/** Newest first. */
export function listApprovals(
  db: Queryable,
  options: { status?: ApprovalStatus; limit?: number } = {},
): ApprovalWithTool[] {
  return selectApprovals(db)
    .where(options.status ? eq(approvals.status, options.status) : undefined)
    .orderBy(desc(approvals.created_at))
    .limit(options.limit ?? 100)
    .all()
    .map(({ approval, tool }) => ({ ...approval, tool }));
}

/**
 * Approves or rejects a pending approval. One UPDATE that only matches a
 * pending row, so of two decisions made at once only the first counts.
 * Undefined when the approval was not pending.
 */
export function decideApproval(
  db: Queryable,
  id: string,
  decision: { status: 'approved' | 'rejected'; decided_by: string; decided_at: Date },
): ApprovalRow | undefined {
  return db
    .update(approvals)
    .set(decision)
    .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
    .returning()
    .get();
}

/** Records how an approved write went. */
export function finishApproval(
  db: Queryable,
  id: string,
  done: Pick<ApprovalRow, 'run_id' | 'outcome' | 'after_screenshot_path'>,
): void {
  db.update(approvals).set(done).where(eq(approvals.id, id)).run();
}

export function createPolicy(
  db: Queryable,
  policy: Pick<PolicyRow, 'tool_id' | 'field' | 'op' | 'value'>,
): PolicyRow {
  return db
    .insert(approval_policies)
    .values({ id: newId(), ...policy })
    .returning()
    .get();
}

export function listPolicies(db: Queryable, options: { tool_id?: string } = {}): PolicyWithTool[] {
  return db
    .select({ policy: approval_policies, tool: tools.name })
    .from(approval_policies)
    .innerJoin(tools, eq(tools.id, approval_policies.tool_id))
    .where(options.tool_id ? eq(approval_policies.tool_id, options.tool_id) : undefined)
    .orderBy(approval_policies.created_at)
    .all()
    .map(({ policy, tool }) => ({ ...policy, tool }));
}

export function deletePolicy(db: Queryable, id: string): boolean {
  return db.delete(approval_policies).where(eq(approval_policies.id, id)).run().changes > 0;
}

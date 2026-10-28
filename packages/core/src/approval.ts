import { z } from 'zod';
import type { ToolDropErrorJson } from './errors.ts';
import type { ApprovalStatus } from './run.ts';

// Safe mode (SPEC, Differentiating features): a write tool shows what it
// will do, and changes the site only once a person, or a policy they set,
// approves.

/** What a write will do, shown before it happens. */
export interface WritePreview {
  /** The page the form is on, or where the request goes. */
  url: string;
  /** What the commit step does, e.g. `click role=button[name="Record payment"]`. */
  action: string;
  /** Each value the recipe fills in, by field. */
  fields: { field: string; value: string }[];
}

/** What `approve_action` and `POST /v1/approvals/:id` take. */
export const approvalDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>['decision'];

/** A write waiting for a decision, or the record of one: the write audit log. */
export interface ApprovalView {
  id: string;
  tool: string;
  /** The tool version that was previewed; only that version may run the write. */
  version: number;
  inputs: Record<string, unknown>;
  status: ApprovalStatus;
  preview: WritePreview;
  /** Which screenshots exist: the filled form before the write, and the page after it. */
  screenshots: { before: boolean; after: boolean };
  /** Who decided: "mcp", "cli", "api-key:<label>" or "policy:<id>". */
  decided_by: string | null;
  decided_at: string | null;
  /** A pending approval can no longer be approved after this. */
  expires_at: string;
  /** How the write went, once it ran. */
  outcome: { ok: boolean; result?: unknown; error?: ToolDropErrorJson; url?: string } | null;
  created_at: string;
}

export const POLICY_OPERATORS = ['<', '<=', '>', '>=', '==', '!='] as const;

/** A rule that approves a tool's writes by itself, e.g. record_payment when amount < 100. */
export const createPolicySchema = z
  .strictObject({
    tool: z.string().min(1),
    /** The input the rule looks at. */
    field: z.string().min(1).max(100),
    op: z.enum(POLICY_OPERATORS),
    value: z.union([z.number(), z.string().min(1).max(200)]),
  })
  .refine((policy) => typeof policy.value === 'number' || policy.op === '==' || policy.op === '!=', {
    message: 'comparing with <, <=, > or >= needs a number',
    path: ['value'],
  });
export type CreatePolicy = z.infer<typeof createPolicySchema>;

export interface PolicyView extends CreatePolicy {
  id: string;
  created_at: string;
}

/** Whether a policy approves a write with these inputs. A missing input never matches. */
export function policyApproves(policy: CreatePolicy, inputs: Record<string, unknown>): boolean {
  const actual = inputs[policy.field];
  if (typeof policy.value === 'string') {
    if (typeof actual !== 'string') return false;
    return policy.op === '==' ? actual === policy.value : actual !== policy.value;
  }
  const number = typeof actual === 'number' ? actual : typeof actual === 'string' ? Number(actual) : NaN;
  if (Number.isNaN(number)) return false;
  switch (policy.op) {
    case '<':
      return number < policy.value;
    case '<=':
      return number <= policy.value;
    case '>':
      return number > policy.value;
    case '>=':
      return number >= policy.value;
    case '==':
      return number === policy.value;
    case '!=':
      return number !== policy.value;
  }
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approvalDecisionSchema,
  createPolicySchema,
  newId,
  policyApproves,
  ToolDropError,
  type ApprovalView,
  type JsonSchema,
  type PolicyView,
  type WritePreview,
} from '@tooldrop/core';
import {
  createApproval,
  createPolicy,
  decideApproval,
  deletePolicy,
  finishApproval,
  getApproval,
  getTool,
  keyAllows,
  listApprovals,
  listPolicies,
  recordRun,
  type ApprovalWithTool,
  type PolicyWithTool,
  type PublishedTool,
} from '@tooldrop/db';
import { formatIssues } from '@tooldrop/llm';
import type { RunOutcome } from '@tooldrop/runtime';
import { requireFullAccess, type Engine, type Scopes } from './engine.ts';

// Safe mode (SPEC, Differentiating features): a call to a write tool shows
// a preview and waits for an approval, from a person or a policy they set.
// The approval row is also the write's audit record: inputs, preview, who
// decided, screenshots from before and after, and the outcome.

/** A preview may be approved for this long; after that, the tool is called again for a fresh one. */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
/** Longer results are not kept in the audit record. */
const MAX_KEPT_RESULT = 10_000;

export class Approvals {
  readonly #engine: Engine;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  /**
   * A call to a write tool. It previews the write; then a dry run returns the
   * preview, a policy that allows these inputs makes the write at once, and
   * otherwise the call ends with `approval_required` and the approval's ID.
   */
  async call(tool: PublishedTool, input: unknown): Promise<RunOutcome> {
    const { dry_run: dryRun, ...inputs } = (input ?? {}) as Record<string, unknown>;
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      throw new ToolDropError('invalid_input', '"dry_run" must be true or false');
    }
    const started = performance.now();
    const runnable = await this.#engine.prepare(tool);
    const { preview, screenshot } = await this.#engine.runtime.preview(runnable, inputs);
    if (dryRun) {
      return {
        result: preview,
        meta: {
          strategy: tool.recipe.strategy,
          duration_ms: Math.round(performance.now() - started),
          recipe_version: tool.version,
          healed: false,
          dry_run: true,
        },
        attempts: [],
        ...(screenshot && { screenshot }),
      };
    }

    const db = this.#engine.db;
    const id = newId();
    const expires = new Date(Date.now() + APPROVAL_TTL_MS);
    await createApproval(db, {
      id,
      tool_id: tool.id,
      version: tool.version,
      inputs,
      preview,
      screenshot_path: screenshot ? this.#saveScreenshot(id, 'before', screenshot) : null,
      expires_at: expires,
    });
    const policies = await listPolicies(db, { tool_id: tool.id });
    const policy = policies.find((rule) => policyApproves(rule, inputs));
    if (policy) {
      await decideApproval(db, id, {
        status: 'approved',
        decided_by: `policy:${policy.id}`,
        decided_at: new Date(),
      });
      return this.#commit(id, tool, inputs);
    }
    throw new ToolDropError(
      'approval_required',
      `${tool.name} changes the site, so it waits for approval: ${summarize(preview)}. Show the preview to the user, then approve or reject approval ${id}.`,
      { details: { approval_id: id, preview, expires_at: expires.toISOString() } },
    );
  }

  /**
   * Approves or rejects a pending write. Approving makes the write at once,
   * on the version that was previewed, and returns its result. An approval
   * is used once; an expired one, or one for a tool that changed since, is
   * refused.
   */
  async decide(
    id: string,
    decision: unknown,
    scopes: Scopes,
    by: string,
  ): Promise<{ approval: ApprovalView; result?: unknown; meta?: RunOutcome['meta'] }> {
    const parsed = approvalDecisionSchema.safeParse({ decision });
    if (!parsed.success) {
      throw new ToolDropError(
        'invalid_input',
        `invalid decision: ${formatIssues(parsed.error.issues).join('; ')}`,
      );
    }
    const db = this.#engine.db;
    const approval = await this.#find(id, scopes);
    if (approval.status !== 'pending') {
      throw new ToolDropError('conflict', `approval ${id} was already ${approval.status}`);
    }
    if (parsed.data.decision === 'reject') {
      await this.#close(id, 'rejected', by);
      return { approval: await this.get(id, scopes) };
    }
    const tool = await getTool(db, approval.tool);
    if (approval.expires_at.getTime() < Date.now()) {
      await this.#close(id, 'rejected', 'expired');
      throw new ToolDropError(
        'conflict',
        `approval ${id} is more than 24 hours old; call ${approval.tool} again for a fresh preview`,
      );
    }
    if (!tool || tool.status === 'disabled' || tool.version !== approval.version) {
      await this.#close(id, 'rejected', 'outdated');
      throw new ToolDropError(
        'conflict',
        `${approval.tool} changed since this preview; call it again for a fresh one`,
      );
    }
    await this.#close(id, 'approved', by);
    const { result, meta } = await this.#commit(id, tool, approval.inputs);
    return { approval: await this.get(id, scopes), result, meta };
  }

  async get(id: string, scopes: Scopes): Promise<ApprovalView> {
    return view(await this.#find(id, scopes));
  }

  /** The write audit log, newest first: approvals of the tools a key may use. */
  async list(scopes: Scopes, options: { status?: ApprovalView['status'] } = {}): Promise<ApprovalView[]> {
    const approvals = await listApprovals(this.#engine.db, options.status ? { status: options.status } : {});
    return approvals.filter((approval) => keyAllows(scopes, approval.tool)).map(view);
  }

  /** A PNG of the filled form before the write, or of the page after it. */
  async screenshot(id: string, which: 'before' | 'after', scopes: Scopes): Promise<Buffer | undefined> {
    const approval = await this.#find(id, scopes);
    const path = which === 'before' ? approval.screenshot_path : approval.after_screenshot_path;
    return path ? readFileSync(join(this.#engine.dataDir, path)) : undefined;
  }

  /** A rule that approves a write tool's calls by itself. Only full-access keys may set one. */
  async createPolicy(input: unknown, scopes: Scopes): Promise<PolicyView> {
    requireFullAccess(scopes);
    const parsed = createPolicySchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolDropError(
        'invalid_input',
        `invalid policy: ${formatIssues(parsed.error.issues).join('; ')}`,
      );
    }
    const tool = await getTool(this.#engine.db, parsed.data.tool);
    if (!tool) throw new ToolDropError('not_found', `no tool named ${parsed.data.tool}`);
    if (tool.authority !== 'write') {
      throw new ToolDropError('invalid_input', `${tool.name} only reads, so it needs no approval`);
    }
    const { field, op, value } = parsed.data;
    const row = await createPolicy(this.#engine.db, { tool_id: tool.id, field, op, value });
    return policyView({ ...row, tool: tool.name });
  }

  async listPolicies(scopes: Scopes): Promise<PolicyView[]> {
    requireFullAccess(scopes);
    return (await listPolicies(this.#engine.db)).map(policyView);
  }

  async deletePolicy(id: string, scopes: Scopes): Promise<void> {
    requireFullAccess(scopes);
    if (!(await deletePolicy(this.#engine.db, id))) throw new ToolDropError('not_found', `no policy ${id}`);
  }

  /** Makes an approved write and records how it went. */
  async #commit(id: string, tool: PublishedTool, inputs: Record<string, unknown>): Promise<RunOutcome> {
    const db = this.#engine.db;
    let runnable = await this.#engine.prepare(tool);
    let { outcome, error, evidence } = await this.#engine.runtime.commit(runnable, inputs);
    // A session that expired before the submit is renewed, and the write tried once more.
    if (error?.code === 'session_expired' && !evidence.committed) {
      runnable = await this.#engine.prepare(tool, { renew: true });
      ({ outcome, error, evidence } = await this.#engine.runtime.commit(runnable, inputs));
    }
    const runId = await recordRun(db, {
      tool_id: tool.id,
      recipe_version: tool.version,
      strategy_used: tool.recipe.strategy,
      duration_ms: outcome?.meta.duration_ms ?? 0,
      ok: outcome !== undefined,
      ...(error && { error_code: error.code }),
    });
    const kept = outcome && JSON.stringify(outcome.result ?? null).length <= MAX_KEPT_RESULT;
    await finishApproval(db, id, {
      run_id: runId,
      after_screenshot_path: evidence.after ? this.#saveScreenshot(id, 'after', evidence.after) : null,
      outcome: error
        ? { ok: false, error, ...(evidence.url_after && { url: evidence.url_after }) }
        : {
            ok: true,
            ...(kept && { result: outcome?.result }),
            ...(evidence.url_after && { url: evidence.url_after }),
          },
    });
    if (!outcome) {
      // Past the submit, the site may or may not have taken the write: only the site can tell.
      const made = evidence.committed
        ? 'The write was submitted, but a step after it failed, so check the site before trying again'
        : 'The write was not made';
      throw new ToolDropError(error?.code ?? 'strategy_failed', `${made}: ${error?.message ?? 'it failed'}`, {
        details: { approval_id: id, committed: evidence.committed === true },
      });
    }
    return { ...outcome, meta: { ...outcome.meta, approval_id: id } };
  }

  async #find(id: string, scopes: Scopes): Promise<ApprovalWithTool> {
    const approval = await getApproval(this.#engine.db, id);
    if (!approval || !keyAllows(scopes, approval.tool)) {
      throw new ToolDropError('not_found', `no approval ${id}`);
    }
    return approval;
  }

  async #close(id: string, status: 'approved' | 'rejected', by: string): Promise<void> {
    if (!(await decideApproval(this.#engine.db, id, { status, decided_by: by, decided_at: new Date() }))) {
      throw new ToolDropError('conflict', `approval ${id} was decided at the same moment by someone else`);
    }
  }

  /** Saves a screenshot next to the other captures; without a data directory, none is kept. */
  #saveScreenshot(id: string, which: 'before' | 'after', png: Buffer): string | null {
    let dataDir: string;
    try {
      dataDir = this.#engine.dataDir;
    } catch {
      return null;
    }
    const path = join('approvals', `${id}-${which}.png`);
    mkdirSync(join(dataDir, 'approvals'), { recursive: true });
    writeFileSync(join(dataDir, path), png);
    return path;
  }
}

/** What a caller sends a tool: its inputs, and for a write tool also `dry_run` (SPEC, Safe mode). */
export function callInputSchema(tool: Pick<PublishedTool, 'authority' | 'input_schema'>): JsonSchema {
  if (tool.authority !== 'write') return tool.input_schema;
  const properties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...tool.input_schema,
    properties: {
      ...properties,
      dry_run: {
        type: 'boolean',
        description: 'Only show what the write would do: nothing is submitted, and no approval is asked for.',
      },
    },
  };
}

/** One line on what a write will do, e.g. "click Record payment on /payments/new with Amount = 100". */
function summarize(preview: WritePreview): string {
  const fields = preview.fields.map((field) => `${field.field} = ${field.value}`).join(', ');
  return `${preview.action} on ${preview.url}${fields ? ` with ${fields}` : ''}`;
}

function view(approval: ApprovalWithTool): ApprovalView {
  return {
    id: approval.id,
    tool: approval.tool,
    version: approval.version,
    inputs: approval.inputs,
    status: approval.status,
    preview: approval.preview,
    screenshots: {
      before: approval.screenshot_path !== null,
      after: approval.after_screenshot_path !== null,
    },
    decided_by: approval.decided_by,
    decided_at: approval.decided_at?.toISOString() ?? null,
    expires_at: approval.expires_at.toISOString(),
    outcome: approval.outcome ?? null,
    created_at: approval.created_at.toISOString(),
  };
}

function policyView(policy: PolicyWithTool): PolicyView {
  return {
    id: policy.id,
    tool: policy.tool,
    field: policy.field,
    op: policy.op,
    value: policy.value,
    created_at: policy.created_at.toISOString(),
  };
}

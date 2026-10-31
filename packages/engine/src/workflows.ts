import {
  fillTemplates,
  isToolDropError,
  newId,
  ToolDropError,
  workflowFileSchema,
  type Authority,
  type JobQuestion,
  type ToolDropErrorJson,
  type WorkflowStep,
  type WorkflowView,
  type WritePreview,
} from '@tooldrop/core';
import {
  addJobQuestion,
  createJob,
  deleteWorkflow,
  getApproval,
  getJob,
  getTool,
  getWorkflow,
  keyAllows,
  listWorkflows,
  saveWorkflow,
  setJobStatus,
  setJobStep,
  type WorkflowRow,
} from '@tooldrop/db';
import { formatIssues } from '@tooldrop/llm';
import { SchemaValidator } from '@tooldrop/runtime';
import type { JobView } from './builds.ts';
import { requireFullAccess, type Engine, type Scopes } from './engine.ts';
import { JobHolds } from './job-holds.ts';

// Multi-site workflows (SPEC, Differentiating features): published tools,
// on any sites, chained into one. A run is a job: each step's inputs are
// filled from the workflow's inputs and earlier results, a step may be
// retried, and when one fails for good the steps already done are undone by
// their compensations, newest first. A write step goes through safe mode as
// any call does: a policy approves it, or the job asks a person.

const ALL: Scopes = ['*'];
const POLL_MS = 500;

/** How one step went, in the job's result or error. */
interface StepReport {
  id: string;
  tool: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

/** A step that failed for good, with why. */
class StepFailure extends Error {
  readonly step: WorkflowStep;
  readonly attempts: number;
  constructor(step: WorkflowStep, attempts: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.step = step;
    this.attempts = attempts;
  }
}

export class Workflows {
  readonly #engine: Engine;
  readonly #holds: JobHolds;
  readonly #validator = new SchemaValidator();
  readonly #running = new Set<Promise<void>>();

  constructor(engine: Engine) {
    this.#engine = engine;
    this.#holds = new JobHolds(engine.db);
  }

  /**
   * Saves a workflow file, new or replacing the one of that name. Every step
   * must call a published tool; the workflow writes when any step or
   * compensation does.
   */
  async save(input: unknown, scopes: Scopes): Promise<WorkflowView> {
    requireFullAccess(scopes);
    const parsed = workflowFileSchema.safeParse(input);
    if (!parsed.success) {
      const problems = formatIssues(parsed.error.issues);
      throw new ToolDropError('invalid_input', `invalid workflow: ${problems.slice(0, 3).join('; ')}`, {
        details: { problems },
      });
    }
    const file = parsed.data;
    const db = this.#engine.db;
    if (await getTool(db, file.name)) {
      throw new ToolDropError(
        'invalid_input',
        `a tool is named ${file.name}; give the workflow another name`,
      );
    }
    let authority: Authority = 'read';
    for (const step of file.steps) {
      for (const name of [step.tool, ...(step.compensate ? [step.compensate.tool] : [])]) {
        const tool = await getTool(db, name);
        if (!tool || tool.status === 'disabled') {
          throw new ToolDropError(
            'not_found',
            `step ${step.id} calls ${name}, which is not a published tool`,
          );
        }
        if (tool.authority === 'write') authority = 'write';
      }
    }
    const row = await saveWorkflow(db, { ...file, authority });
    this.#engine.toolsChanged();
    return view(row);
  }

  /** The workflows a key may run. */
  async list(scopes: Scopes): Promise<WorkflowView[]> {
    return (await listWorkflows(this.#engine.db)).filter((row) => keyAllows(scopes, row.name)).map(view);
  }

  async get(name: string, scopes: Scopes): Promise<WorkflowView> {
    return view(await this.#find(name, scopes));
  }

  async delete(name: string, scopes: Scopes): Promise<void> {
    requireFullAccess(scopes);
    if (!(await deleteWorkflow(this.#engine.db, name)))
      throw new ToolDropError('not_found', `no workflow ${name}`);
    this.#engine.toolsChanged();
  }

  /** Starts a run: a job that the caller polls, and answers when a write asks for approval. */
  async start(name: string, input: unknown, scopes: Scopes): Promise<JobView> {
    const workflow = await this.#find(name, scopes);
    const args = structuredClone((input ?? {}) as Record<string, unknown>);
    const checked = this.#validator.input(workflow.input_schema, args);
    if (!checked.ok) {
      throw new ToolDropError(
        'invalid_input',
        `input does not match ${name}'s schema: ${checked.errors.slice(0, 5).join('; ')}`,
        { details: { errors: checked.errors } },
      );
    }
    const job = await createJob(this.#engine.db, {
      kind: 'workflow',
      input: { workflow: name, input: args },
    });
    // A run lives in the process that started it: it may wait long for an approval, so no queue holds it.
    this.#holds.hold(job.id);
    const running = this.#run(job.id, workflow, args).finally(() => {
      this.#holds.release(job.id);
      this.#running.delete(running);
    });
    this.#running.add(running);
    return this.#engine.builds.view(job.id);
  }

  /** Waits until every run of this process has finished. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  async #find(name: string, scopes: Scopes): Promise<WorkflowRow> {
    const workflow = await getWorkflow(this.#engine.db, name);
    if (!workflow || !keyAllows(scopes, name)) throw new ToolDropError('not_found', `no workflow ${name}`);
    return workflow;
  }

  async #run(jobId: string, workflow: WorkflowRow, input: Record<string, unknown>): Promise<void> {
    const db = this.#engine.db;
    const context = { input, steps: {} as Record<string, { result: unknown }> };
    const done: WorkflowStep[] = [];
    const steps: StepReport[] = [];
    try {
      await setJobStatus(db, jobId, 'running', { step: 'starting' });
      for (const [index, step] of workflow.steps.entries()) {
        const label = `step ${index + 1} of ${workflow.steps.length} (${step.id})`;
        await setJobStep(db, jobId, `${label}: ${step.tool}`);
        const inputs = fillTemplates(step.inputs, context);
        let attempts = 0;
        for (;;) {
          attempts += 1;
          try {
            context.steps[step.id] = { result: await this.#call(jobId, label, step.tool, inputs) };
            break;
          } catch (error) {
            // A rejected write is someone's decision, not a fault, so it is not tried again.
            if (attempts > step.retries || rejected(error)) throw new StepFailure(step, attempts, error);
            await sleep(1000 * 2 ** (attempts - 1));
          }
        }
        done.push(step);
        steps.push({ id: step.id, tool: step.tool, ok: true, attempts });
      }
      const last = workflow.steps.at(-1);
      const output =
        workflow.output !== null && workflow.output !== undefined
          ? fillTemplates(workflow.output, context)
          : last && context.steps[last.id]?.result;
      await setJobStatus(db, jobId, 'succeeded', { step: null, result: { output, steps } });
    } catch (error) {
      const failure = error instanceof StepFailure ? error : undefined;
      if (failure) {
        steps.push({
          id: failure.step.id,
          tool: failure.step.tool,
          ok: false,
          attempts: failure.attempts,
          error: failure.message,
        });
      }
      const compensations = await this.#undo(jobId, done, context);
      const reason: unknown = failure ? failure.cause : error;
      const cause: ToolDropErrorJson = isToolDropError(reason)
        ? reason.toJSON()
        : { code: 'internal', message: reason instanceof Error ? reason.message : String(reason) };
      const undone = compensations.filter((entry) => entry.ok).map((entry) => entry.id);
      const notUndone = compensations.filter((entry) => !entry.ok).map((entry) => entry.id);
      const summary = [
        failure ? `step ${failure.step.id} (${failure.step.tool}) failed: ${cause.message}` : cause.message,
        undone.length > 0 ? `Undone: ${undone.join(', ')}.` : '',
        notUndone.length > 0 ? `Could not undo: ${notUndone.join(', ')}; check those sites.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      await setJobStatus(db, jobId, 'failed', {
        step: null,
        error: { code: cause.code, message: summary, details: { steps, compensations } },
      }).catch(() => undefined);
    }
  }

  /** Runs the compensations of the steps done, newest first. One that fails does not stop the others. */
  async #undo(
    jobId: string,
    done: WorkflowStep[],
    context: { input: Record<string, unknown>; steps: Record<string, { result: unknown }> },
  ): Promise<{ id: string; tool: string; ok: boolean; error?: string }[]> {
    const compensations: { id: string; tool: string; ok: boolean; error?: string }[] = [];
    for (const step of [...done].reverse()) {
      if (!step.compensate) continue;
      const label = `undoing ${step.id}`;
      try {
        await setJobStep(this.#engine.db, jobId, `${label}: ${step.compensate.tool}`);
        await this.#call(jobId, label, step.compensate.tool, fillTemplates(step.compensate.inputs, context));
        compensations.push({ id: step.id, tool: step.compensate.tool, ok: true });
      } catch (error) {
        compensations.push({
          id: step.id,
          tool: step.compensate.tool,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return compensations;
  }

  /** Calls a tool for a step: a read runs at once; a write needs a policy or a person's approval. */
  async #call(jobId: string, label: string, name: string, inputs: unknown): Promise<unknown> {
    try {
      return (await this.#engine.runTool(name, inputs)).result;
    } catch (error) {
      if (!isToolDropError(error, 'approval_required')) throw error;
      const { approval_id: approvalId, preview } = error.details as {
        approval_id: string;
        preview: WritePreview;
      };
      return this.#approved(jobId, label, name, approvalId, preview);
    }
  }

  /**
   * Waits for a person to decide a write: by answering the job's question,
   * or on the approval itself (the Approvals page, approve_action). Returns
   * the write's result once it is made.
   */
  async #approved(
    jobId: string,
    label: string,
    name: string,
    approvalId: string,
    preview: WritePreview,
  ): Promise<unknown> {
    const db = this.#engine.db;
    const fields = preview.fields.map((field) => `${field.field} = ${field.value}`).join(', ');
    const question: JobQuestion = {
      id: newId(),
      text: `${label} calls ${name}, which changes the site: ${preview.action} on ${preview.url}${fields ? ` with ${fields}` : ''}. Approve it? (approval ${approvalId}, also on the Approvals page)`,
      options: ['approve', 'reject'],
      asked_at: Date.now(),
    };
    await addJobQuestion(db, jobId, question);
    for (;;) {
      const approval = await getApproval(db, approvalId);
      // Decided elsewhere: an approved write is done once its outcome is recorded.
      if (approval?.status === 'rejected') {
        await setJobStatus(db, jobId, 'running');
        throw rejection(name, approval.decided_by);
      }
      if (approval?.status === 'approved' && approval.outcome) {
        await setJobStatus(db, jobId, 'running');
        const outcome = approval.outcome;
        if (!outcome.ok)
          throw new ToolDropError(
            outcome.error?.code ?? 'strategy_failed',
            outcome.error?.message ?? `${name} failed`,
          );
        return outcome.result;
      }
      const answer = (await getJob(db, jobId))?.answers.find((entry) => entry.question_id === question.id);
      if (answer && approval?.status === 'pending') {
        await setJobStatus(db, jobId, 'running');
        const decision = answer.text.trim().toLowerCase() === 'approve' ? 'approve' : 'reject';
        const decided = await this.#engine.decideApproval(approvalId, decision, ALL, `job:${jobId}`);
        if (decision === 'reject') throw rejection(name, `job:${jobId}`);
        return decided.result;
      }
      await sleep(POLL_MS);
    }
  }
}

function rejection(tool: string, by: string | null): ToolDropError {
  return new ToolDropError('conflict', `the write of ${tool} was rejected${by ? ` by ${by}` : ''}`, {
    details: { rejected: true },
  });
}

function rejected(error: unknown): boolean {
  return isToolDropError(error) && (error.details as { rejected?: unknown } | undefined)?.rejected === true;
}

function view(row: WorkflowRow): WorkflowView {
  return {
    name: row.name,
    description: row.description,
    authority: row.authority,
    input_schema: row.input_schema,
    steps: row.steps,
    ...(row.output !== null && row.output !== undefined && { output: row.output }),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

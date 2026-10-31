import {
  canTransition,
  newId,
  ToolDropError,
  type JobAnswer,
  type JobKind,
  type JobQuestion,
  type JobStatus,
  type ToolDropErrorJson,
} from '@tooldrop/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { first, one, tablesOf, type Queryable } from '../client.ts';
import type { captures, jobs } from '../schema.ts';

// Build, heal and discover jobs (SPEC, Build pipeline), and the captures they
// collect. Status changes follow core's JOB_TRANSITIONS.

export type JobRow = typeof jobs.$inferSelect;
export type CaptureRow = typeof captures.$inferSelect;

export async function createJob(db: Queryable, job: { kind: JobKind; input: unknown }): Promise<JobRow> {
  const { jobs } = tablesOf(db);
  return one(await db.insert(jobs).values({ id: newId(), kind: job.kind, input: job.input }).returning());
}

export async function getJob(db: Queryable, id: string): Promise<JobRow | undefined> {
  const { jobs } = tablesOf(db);
  return first(await db.select().from(jobs).where(eq(jobs.id, id)));
}

/** Newest first, optionally only one status or kind: e.g. the jobs waiting for an answer, or the heals. */
export async function listJobs(
  db: Queryable,
  options: { status?: JobStatus; kind?: JobKind; limit?: number } = {},
): Promise<JobRow[]> {
  const { jobs } = tablesOf(db);
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        options.status ? eq(jobs.status, options.status) : undefined,
        options.kind ? eq(jobs.kind, options.kind) : undefined,
      ),
    )
    .orderBy(desc(jobs.created_at))
    .limit(options.limit ?? 50);
  return rows;
}

/** Moves a job to a new status. A job that has finished never changes again. */
export async function setJobStatus(
  db: Queryable,
  id: string,
  status: JobStatus,
  fields: { step?: string | null; result?: unknown; error?: ToolDropErrorJson } = {},
): Promise<JobRow> {
  const { jobs } = tablesOf(db);
  const job = await requireJob(db, id);
  if (job.status !== status && !canTransition(job.status, status)) {
    throw new ToolDropError('internal', `job ${id} cannot go from ${job.status} to ${status}`);
  }
  return one(
    await db
      .update(jobs)
      .set({
        status,
        ...(fields.step !== undefined && { step: fields.step }),
        ...(fields.result !== undefined && { result: fields.result }),
        ...(fields.error !== undefined && { error: fields.error }),
      })
      .where(eq(jobs.id, id))
      .returning(),
  );
}

export async function setJobStep(db: Queryable, id: string, step: string): Promise<void> {
  const { jobs } = tablesOf(db);
  await db.update(jobs).set({ step }).where(eq(jobs.id, id));
}

/** Marks a job as still alive: the process running it writes this every few seconds. */
export async function touchJob(db: Queryable, id: string): Promise<void> {
  const { jobs } = tablesOf(db);
  await db.update(jobs).set({ updated_at: new Date() }).where(eq(jobs.id, id));
}

/** Adds a clarifying question and pauses the job until it is answered. */
export async function addJobQuestion(db: Queryable, id: string, question: JobQuestion): Promise<JobRow> {
  const { jobs } = tablesOf(db);
  const job = await setJobStatus(db, id, 'waiting_for_answer');
  return one(
    await db
      .update(jobs)
      .set({ questions: [...job.questions, question] })
      .where(eq(jobs.id, id))
      .returning(),
  );
}

/** Stores an answer. Only an open question of a waiting job can be answered, and only once. */
export async function addJobAnswer(db: Queryable, id: string, answer: JobAnswer): Promise<JobRow> {
  const { jobs } = tablesOf(db);
  const job = await requireJob(db, id);
  if (job.status !== 'waiting_for_answer') {
    throw new ToolDropError('invalid_input', `job ${id} is ${job.status}, not waiting for an answer`);
  }
  if (!job.questions.some((question) => question.id === answer.question_id)) {
    throw new ToolDropError('not_found', `job ${id} has no question ${answer.question_id}`);
  }
  if (job.answers.some((existing) => existing.question_id === answer.question_id)) {
    throw new ToolDropError('invalid_input', `question ${answer.question_id} is already answered`);
  }
  return one(
    await db
      .update(jobs)
      .set({ answers: [...job.answers, answer] })
      .where(eq(jobs.id, id))
      .returning(),
  );
}

/**
 * Fails every job that was still queued, running or waiting: in-process jobs
 * do not survive a restart. Returns how many there were.
 */
export async function failUnfinishedJobs(db: Queryable, message: string): Promise<number> {
  const { jobs } = tablesOf(db);
  const failed = await db
    .update(jobs)
    .set({ status: 'failed', step: null, error: { code: 'internal', message } })
    .where(inArray(jobs.status, ['queued', 'running', 'waiting_for_answer']))
    .returning({ id: jobs.id });
  return failed.length;
}

export interface CaptureInput {
  job_id: string;
  har_path: string;
  dom_snapshots?: string[];
  ax_trees?: string[];
  actions?: unknown[];
}

/** Indexes a capture whose files are already in the data directory. */
export async function saveCapture(db: Queryable, capture: CaptureInput): Promise<CaptureRow> {
  const { captures } = tablesOf(db);
  return one(
    await db
      .insert(captures)
      .values({
        id: newId(),
        job_id: capture.job_id,
        har_path: capture.har_path,
        dom_snapshots: capture.dom_snapshots ?? [],
        ax_trees: capture.ax_trees ?? [],
        actions: capture.actions ?? [],
      })
      .returning(),
  );
}

export async function listCaptures(db: Queryable, jobId: string): Promise<CaptureRow[]> {
  const { captures } = tablesOf(db);
  const rows = await db
    .select()
    .from(captures)
    .where(eq(captures.job_id, jobId))
    .orderBy(captures.created_at);
  return rows;
}

async function requireJob(db: Queryable, id: string): Promise<JobRow> {
  const job = await getJob(db, id);
  if (!job) throw new ToolDropError('not_found', `no job ${id}`);
  return job;
}

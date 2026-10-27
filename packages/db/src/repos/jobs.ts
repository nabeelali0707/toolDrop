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
import { desc, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../client.ts';
import { captures, jobs } from '../schema.ts';

// Build, heal and discover jobs (SPEC, Build pipeline), and the captures they
// collect. Status changes follow core's JOB_TRANSITIONS.

export type JobRow = typeof jobs.$inferSelect;
export type CaptureRow = typeof captures.$inferSelect;

export function createJob(db: Queryable, job: { kind: JobKind; input: unknown }): JobRow {
  return db.insert(jobs).values({ id: newId(), kind: job.kind, input: job.input }).returning().get();
}

export function getJob(db: Queryable, id: string): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobs(db: Queryable, options: { status?: JobStatus; limit?: number } = {}): JobRow[] {
  const query = db.select().from(jobs);
  return (options.status ? query.where(eq(jobs.status, options.status)) : query)
    .orderBy(desc(jobs.created_at))
    .limit(options.limit ?? 50)
    .all();
}

/** Moves a job to a new status. A job that has finished never changes again. */
export function setJobStatus(
  db: Queryable,
  id: string,
  status: JobStatus,
  fields: { step?: string | null; result?: unknown; error?: ToolDropErrorJson } = {},
): JobRow {
  const job = requireJob(db, id);
  if (job.status !== status && !canTransition(job.status, status)) {
    throw new ToolDropError('internal', `job ${id} cannot go from ${job.status} to ${status}`);
  }
  return db
    .update(jobs)
    .set({
      status,
      ...(fields.step !== undefined && { step: fields.step }),
      ...(fields.result !== undefined && { result: fields.result }),
      ...(fields.error !== undefined && { error: fields.error }),
    })
    .where(eq(jobs.id, id))
    .returning()
    .get();
}

export function setJobStep(db: Queryable, id: string, step: string): void {
  db.update(jobs).set({ step }).where(eq(jobs.id, id)).run();
}

/** Marks a job as still alive: the process running it writes this every few seconds. */
export function touchJob(db: Queryable, id: string): void {
  db.update(jobs).set({ updated_at: new Date() }).where(eq(jobs.id, id)).run();
}

/** Adds a clarifying question and pauses the job until it is answered. */
export function addJobQuestion(db: Queryable, id: string, question: JobQuestion): JobRow {
  const job = setJobStatus(db, id, 'waiting_for_answer');
  return db
    .update(jobs)
    .set({ questions: [...job.questions, question] })
    .where(eq(jobs.id, id))
    .returning()
    .get();
}

/** Stores an answer. Only an open question of a waiting job can be answered, and only once. */
export function addJobAnswer(db: Queryable, id: string, answer: JobAnswer): JobRow {
  const job = requireJob(db, id);
  if (job.status !== 'waiting_for_answer') {
    throw new ToolDropError('invalid_input', `job ${id} is ${job.status}, not waiting for an answer`);
  }
  if (!job.questions.some((question) => question.id === answer.question_id)) {
    throw new ToolDropError('not_found', `job ${id} has no question ${answer.question_id}`);
  }
  if (job.answers.some((existing) => existing.question_id === answer.question_id)) {
    throw new ToolDropError('invalid_input', `question ${answer.question_id} is already answered`);
  }
  return db
    .update(jobs)
    .set({ answers: [...job.answers, answer] })
    .where(eq(jobs.id, id))
    .returning()
    .get();
}

/**
 * Fails every job that was still queued, running or waiting: in-process jobs
 * do not survive a restart. Returns how many there were.
 */
export function failUnfinishedJobs(db: Queryable, message: string): number {
  return db
    .update(jobs)
    .set({ status: 'failed', step: null, error: { code: 'internal', message } })
    .where(inArray(jobs.status, ['queued', 'running', 'waiting_for_answer']))
    .returning({ id: jobs.id })
    .all().length;
}

export interface CaptureInput {
  job_id: string;
  har_path: string;
  dom_snapshots?: string[];
  ax_trees?: string[];
  actions?: unknown[];
}

/** Indexes a capture whose files are already in the data directory. */
export function saveCapture(db: Queryable, capture: CaptureInput): CaptureRow {
  return db
    .insert(captures)
    .values({
      id: newId(),
      job_id: capture.job_id,
      har_path: capture.har_path,
      dom_snapshots: capture.dom_snapshots ?? [],
      ax_trees: capture.ax_trees ?? [],
      actions: capture.actions ?? [],
    })
    .returning()
    .get();
}

export function listCaptures(db: Queryable, jobId: string): CaptureRow[] {
  return db.select().from(captures).where(eq(captures.job_id, jobId)).orderBy(captures.created_at).all();
}

function requireJob(db: Queryable, id: string): JobRow {
  const job = getJob(db, id);
  if (!job) throw new ToolDropError('not_found', `no job ${id}`);
  return job;
}

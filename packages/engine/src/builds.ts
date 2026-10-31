import {
  buildInputSchema,
  newId,
  ToolDropError,
  type BuildInput,
  type JobAnswer,
  type JobQuestion,
  type ToolDropErrorJson,
} from '@tooldrop/core';
import { buildTool, writeCapture, type BuildDeps } from '@tooldrop/compiler';
import {
  addJobAnswer,
  addJobQuestion,
  createJob,
  findTools,
  getJob,
  getTool,
  jobUsage,
  recordLlmCall,
  saveCapture,
  setJobStatus,
  setJobStep,
  type JobRow,
  type JobUsage,
} from '@tooldrop/db';
import { formatIssues, Llm, type ModelSetup } from '@tooldrop/llm';
import type { Browser } from 'playwright';
import type { Engine } from './engine.ts';
import { JobHolds } from './job-holds.ts';
import { InProcessQueue, type JobQueue } from './queue.ts';

// Build jobs (SPEC, Build pipeline): start, ask, answer and publish. The
// compiler does the work; this keeps the job in the database, so get_job and
// answers work from any process that shares it, and any process that shares
// the queue can run it.

/** A job as callers see it: get_job, GET /v1/jobs/:id and `tooldrop build`. */
export interface JobView {
  id: string;
  kind: JobRow['kind'];
  status: JobRow['status'];
  /** What a running job is doing now. */
  step: string | null;
  input: unknown;
  /** Each question with its answer, once given. */
  questions: (JobQuestion & { answer?: string })[];
  result: unknown;
  error: ToolDropErrorJson | null;
  /** Model calls, tokens and time so far (DECISIONS.md, D-013). */
  usage: JobUsage;
  created_at: string;
  updated_at: string;
}

export interface BuildOptions {
  /** The models; without them builds fail with `llm_unavailable`. */
  models?: ModelSetup;
  /** A running browser for captures; one is launched per build when absent. */
  browser?: Browser;
  /** Where build jobs wait: in this process (the default), or on Valkey when self-hosted. */
  queue?: JobQueue;
  /** How long an unfinished job may go untouched before it counts as abandoned (default 60 s). */
  staleMs?: number;
  /** Passed through to the compiler: validation rate limit, wait times, explore budget. */
  compiler?: Pick<BuildDeps, 'rateLimit' | 'waitMs' | 'actionBudget'>;
}

/** An unfinished job nobody has touched for this long belongs to a process that stopped. */
const STALE_MS = 60_000;
const ANSWER_POLL_MS = 500;
const UNFINISHED = new Set(['queued', 'running', 'waiting_for_answer']);

export class Builds {
  readonly #engine: Engine;
  readonly #options: BuildOptions;
  readonly #queue: JobQueue;
  readonly #llm: Llm | undefined;
  /** Jobs this process answers for, so it never takes them for stale. */
  readonly #holds: JobHolds;
  readonly #answered = new Map<string, () => void>();

  constructor(engine: Engine, options: BuildOptions = {}) {
    this.#engine = engine;
    this.#options = options;
    this.#holds = new JobHolds(engine.db);
    this.#queue = options.queue ?? new InProcessQueue(1);
    this.#queue.process((job) => this.#take(job.id));
    this.#llm = options.models
      ? new Llm({
          ...options.models,
          // Usage logging never holds up or fails a model call.
          onCall: (call) => {
            if (call.job_id)
              recordLlmCall(engine.db, { ...call, job_id: call.job_id }).catch(() => undefined);
          },
        })
      : undefined;
  }

  /** The models builds use; heals use them too. Undefined when none is configured. */
  get llm(): Llm | undefined {
    return this.#llm;
  }

  /** The browser for captures, when one was given (tests share one). */
  get browser(): Browser | undefined {
    return this.#options.browser;
  }

  /** Starts a build job, or finishes at once when a published tool already does the task (step 1). */
  async start(input: unknown): Promise<JobView> {
    const parsed = buildInputSchema.safeParse(input);
    if (!parsed.success) {
      const problems = formatIssues(parsed.error.issues);
      throw new ToolDropError('invalid_input', `invalid build request: ${problems.slice(0, 3).join('; ')}`, {
        details: { problems },
      });
    }
    const request = parsed.data;
    if (request.recording_id) this.#engine.getRecording(request.recording_id);

    const db = this.#engine.db;
    const job = await createJob(db, { kind: 'build', input: request });
    const existing = await this.#existingTool(request);
    if (existing) {
      await setJobStatus(db, job.id, 'running');
      await setJobStatus(db, job.id, 'succeeded', {
        result: { tool: existing, reused: true, message: `${existing} already does this task` },
      });
      return this.view(job.id);
    }

    // A job waiting in this process's own queue is alive as long as this process is.
    if (!this.#queue.durable) this.#holds.hold(job.id);
    await this.#queue.enqueue({ id: job.id, kind: 'build' });
    return this.view(job.id);
  }

  async view(id: string): Promise<JobView> {
    const db = this.#engine.db;
    let job = await getJob(db, id);
    if (!job) throw new ToolDropError('not_found', `no job ${id}`);
    if (
      UNFINISHED.has(job.status) &&
      !this.#holds.has(id) &&
      // A job waiting in a shared queue belongs to the queue, not to a process.
      !(job.status === 'queued' && this.#queue.durable) &&
      Date.now() - job.updated_at.getTime() > (this.#options.staleMs ?? STALE_MS)
    ) {
      job = await setJobStatus(db, id, 'failed', {
        step: null,
        error: {
          code: 'internal',
          message: 'the toolDrop process running this job stopped; start the build again',
        },
      });
    }
    const answers = new Map(job.answers.map((answer) => [answer.question_id, answer.text]));
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      step: job.step,
      input: job.input,
      questions: job.questions.map((question) => {
        const answer = answers.get(question.id);
        return answer === undefined ? question : { ...question, answer };
      }),
      result: job.result ?? null,
      error: (job.error as ToolDropErrorJson | null) ?? null,
      usage: await jobUsage(db, id),
      created_at: job.created_at.toISOString(),
      updated_at: job.updated_at.toISOString(),
    };
  }

  /** Answers a job's question; the waiting build picks it up, in this process or another. */
  async answer(jobId: string, questionId: string, text: string): Promise<JobView> {
    const answer: JobAnswer = { question_id: questionId, text, answered_at: Date.now() };
    await addJobAnswer(this.#engine.db, jobId, answer);
    this.#answered.get(questionId)?.();
    return this.view(jobId);
  }

  /** Waits until every build of this process has finished, e.g. before exit. */
  idle(): Promise<void> {
    return this.#queue.idle();
  }

  /** Stops taking builds from the queue. */
  close(): Promise<void> {
    return this.#queue.close();
  }

  /** Runs a job this process took from the queue. */
  async #take(id: string): Promise<void> {
    this.#holds.hold(id);
    try {
      const job = await getJob(this.#engine.db, id);
      // Only a job that still waits: one failed meanwhile, or taken before, is left alone.
      if (job?.status !== 'queued') return;
      await this.#run(id, buildInputSchema.parse(job.input));
    } finally {
      this.#holds.release(id);
    }
  }

  async #existingTool(request: BuildInput): Promise<string | undefined> {
    const words = request.task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3);
    const origin = new URL(request.url).origin;
    const found = await findTools(this.#engine.db, { site: origin, task: request.task });
    const match = found.find((tool) => {
      const text = `${tool.name.replaceAll('_', ' ')} ${tool.description}`.toLowerCase();
      return tool.site.origin === origin && words.length > 0 && words.every((word) => text.includes(word));
    });
    return match?.name;
  }

  async #run(jobId: string, request: BuildInput): Promise<void> {
    const db = this.#engine.db;
    try {
      await setJobStatus(db, jobId, 'running', { step: 'starting' });
      const llm = this.#llm;
      if (!llm) {
        throw new ToolDropError('llm_unavailable', 'no model is configured; run `tooldrop init`');
      }
      await llm.provider.ping?.([...new Set(Object.values(llm.models))]);

      // Step 2: sign in, when the site has a saved login.
      await setJobStep(db, jobId, 'signing in');
      const signedIn = await this.#engine.sessions.ensure(request.url, {
        ask: (question) => this.#ask(jobId, question),
      });

      const result = await buildTool(
        {
          url: request.url,
          task: request.task,
          authority: request.authority,
          ...(request.inputs_hint !== undefined && { inputs_hint: request.inputs_hint }),
          ...(request.recording_id && { recording: this.#engine.getRecording(request.recording_id) }),
        },
        {
          llm,
          runtime: this.#engine.runtime,
          jobId,
          nameTaken: async (name) => (await getTool(db, name)) !== undefined,
          ...(signedIn && { signedIn, secrets: await this.#engine.sessions.secretsFor(request.url) }),
          ...(this.#options.browser && { browser: this.#options.browser }),
          ...this.#options.compiler,
        },
        {
          step: (name) => setJobStep(db, jobId, name),
          ask: (question) => this.#ask(jobId, question),
          recording: (id) => this.#engine.getRecording(id),
          captured: async (capture, masker) => {
            const stored = writeCapture(capture, this.#engine.dataDir, { masker });
            await saveCapture(db, { job_id: jobId, ...stored });
          },
        },
      );
      const published = await this.#engine.publish(result.tool, result.site, {
        created_by: 'build',
        change_reason: `built for: ${request.task}`,
        test_inputs: result.test_inputs,
      });
      await setJobStatus(db, jobId, 'succeeded', {
        step: null,
        result: {
          tool: published.name,
          version: published.version,
          strategy: result.strategy,
          attempts: result.attempts,
          input_schema: published.input_schema,
          output_schema: published.output_schema,
          sample: result.sample,
        },
      });
    } catch (error) {
      const json =
        error instanceof ToolDropError
          ? error.toJSON()
          : { code: 'internal' as const, message: error instanceof Error ? error.message : String(error) };
      await setJobStatus(db, jobId, 'failed', { step: null, error: json });
    }
  }

  /** Pauses the job on a question until an answer arrives, here or from another process. */
  async #ask(jobId: string, question: { text: string; options?: string[] }): Promise<string> {
    const db = this.#engine.db;
    const id = newId();
    await addJobQuestion(db, jobId, {
      id,
      text: question.text,
      ...(question.options && { options: question.options }),
      asked_at: Date.now(),
    });
    for (;;) {
      const answer = (await getJob(db, jobId))?.answers.find((a) => a.question_id === id);
      if (answer) {
        this.#answered.delete(id);
        await setJobStatus(db, jobId, 'running');
        return answer.text;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ANSWER_POLL_MS);
        this.#answered.set(id, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

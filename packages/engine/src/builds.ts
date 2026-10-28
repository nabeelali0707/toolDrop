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
  touchJob,
  type JobRow,
  type JobUsage,
} from '@tooldrop/db';
import { formatIssues, Llm, type ModelSetup } from '@tooldrop/llm';
import type { Browser } from 'playwright';
import type { Engine } from './engine.ts';
import { InProcessQueue, type JobQueue } from './queue.ts';

// Build jobs (SPEC, Build pipeline): start, ask, answer and publish. The
// compiler does the work; this keeps the job in the database, so get_job and
// answers work from any process that shares it.

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
  queue?: JobQueue;
  /** How long an unfinished job may go untouched before it counts as abandoned (default 60 s). */
  staleMs?: number;
  /** Passed through to the compiler: validation rate limit, wait times, explore budget. */
  compiler?: Pick<BuildDeps, 'rateLimit' | 'waitMs' | 'actionBudget'>;
}

const HEARTBEAT_MS = 10_000;
/** An unfinished job nobody has touched for this long belongs to a process that stopped. */
const STALE_MS = 60_000;
const ANSWER_POLL_MS = 500;
const UNFINISHED = new Set(['queued', 'running', 'waiting_for_answer']);

export class Builds {
  readonly #engine: Engine;
  readonly #options: BuildOptions;
  readonly #queue: JobQueue;
  readonly #llm: Llm | undefined;
  /** Jobs this process runs, so it never takes them for stale. */
  readonly #active = new Set<string>();
  readonly #answered = new Map<string, () => void>();

  constructor(engine: Engine, options: BuildOptions = {}) {
    this.#engine = engine;
    this.#options = options;
    this.#queue = options.queue ?? new InProcessQueue(1);
    this.#llm = options.models
      ? new Llm({
          ...options.models,
          onCall: (call) => {
            if (call.job_id) recordLlmCall(engine.db, { ...call, job_id: call.job_id });
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
  start(input: unknown): JobView {
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
    const job = createJob(db, { kind: 'build', input: request });
    const existing = this.#existingTool(request);
    if (existing) {
      setJobStatus(db, job.id, 'running');
      setJobStatus(db, job.id, 'succeeded', {
        result: { tool: existing, reused: true, message: `${existing} already does this task` },
      });
      return this.view(job.id);
    }

    this.#active.add(job.id);
    const heartbeat = setInterval(() => touchJob(db, job.id), HEARTBEAT_MS);
    heartbeat.unref();
    this.#queue.enqueue(async () => {
      try {
        await this.#run(job.id, request);
      } finally {
        clearInterval(heartbeat);
        this.#active.delete(job.id);
      }
    });
    return this.view(job.id);
  }

  view(id: string): JobView {
    const db = this.#engine.db;
    let job = getJob(db, id);
    if (!job) throw new ToolDropError('not_found', `no job ${id}`);
    if (
      UNFINISHED.has(job.status) &&
      !this.#active.has(id) &&
      Date.now() - job.updated_at.getTime() > (this.#options.staleMs ?? STALE_MS)
    ) {
      job = setJobStatus(db, id, 'failed', {
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
      usage: jobUsage(db, id),
      created_at: job.created_at.toISOString(),
      updated_at: job.updated_at.toISOString(),
    };
  }

  /** Answers a job's question; the waiting build picks it up, in this process or another. */
  answer(jobId: string, questionId: string, text: string): JobView {
    const answer: JobAnswer = { question_id: questionId, text, answered_at: Date.now() };
    addJobAnswer(this.#engine.db, jobId, answer);
    this.#answered.get(questionId)?.();
    return this.view(jobId);
  }

  /** Waits until every build of this process has finished, e.g. before exit. */
  idle(): Promise<void> {
    return this.#queue.idle();
  }

  #existingTool(request: BuildInput): string | undefined {
    const words = request.task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3);
    const origin = new URL(request.url).origin;
    const match = findTools(this.#engine.db, { site: origin, task: request.task }).find((tool) => {
      const text = `${tool.name.replaceAll('_', ' ')} ${tool.description}`.toLowerCase();
      return tool.site.origin === origin && words.length > 0 && words.every((word) => text.includes(word));
    });
    return match?.name;
  }

  async #run(jobId: string, request: BuildInput): Promise<void> {
    const db = this.#engine.db;
    try {
      setJobStatus(db, jobId, 'running', { step: 'starting' });
      const llm = this.#llm;
      if (!llm) {
        throw new ToolDropError('llm_unavailable', 'no model is configured; run `tooldrop init`');
      }
      await llm.provider.ping?.([...new Set(Object.values(llm.models))]);

      // Step 2: sign in, when the site has a saved login.
      setJobStep(db, jobId, 'signing in');
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
          nameTaken: (name) => getTool(db, name) !== undefined,
          ...(signedIn && { signedIn }),
          ...(this.#options.browser && { browser: this.#options.browser }),
          ...this.#options.compiler,
        },
        {
          step: (name) => setJobStep(db, jobId, name),
          ask: (question) => this.#ask(jobId, question),
          recording: (id) => this.#engine.getRecording(id),
          captured: (capture, masker) => {
            const stored = writeCapture(capture, this.#engine.dataDir, { masker });
            saveCapture(db, { job_id: jobId, ...stored });
          },
        },
      );
      const published = this.#engine.publish(result.tool, result.site, {
        created_by: 'build',
        change_reason: `built for: ${request.task}`,
        test_inputs: result.test_inputs,
      });
      setJobStatus(db, jobId, 'succeeded', {
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
      setJobStatus(db, jobId, 'failed', { step: null, error: json });
    }
  }

  /** Pauses the job on a question until an answer arrives, here or from another process. */
  async #ask(jobId: string, question: { text: string; options?: string[] }): Promise<string> {
    const db = this.#engine.db;
    const id = newId();
    addJobQuestion(db, jobId, {
      id,
      text: question.text,
      ...(question.options && { options: question.options }),
      asked_at: Date.now(),
    });
    for (;;) {
      const answer = getJob(db, jobId)?.answers.find((a) => a.question_id === id);
      if (answer) {
        this.#answered.delete(id);
        setJobStatus(db, jobId, 'running');
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

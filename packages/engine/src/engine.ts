import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectMailboxSchema,
  ToolDropError,
  type ApprovalView,
  type JobKind,
  type JobStatus,
  type LoginView,
  type PolicyView,
  type Recipe,
  type RecipeOrigin,
  type Recording,
  type ToolFile,
  type WorkflowView,
  type WatchView,
} from '@tooldrop/core';
import {
  findTools,
  getTool,
  getLoginRecipe,
  getVersion,
  getWorkflow,
  keyAllows,
  listJobs,
  listLogins,
  listRuns,
  listTools,
  listVersions,
  publishTool,
  recordRun,
  rollbackTool,
  runStats,
  siteLogin,
  testInputs,
  toolJobs,
  usageByJob,
  type Db,
  type JobUsage,
  type PublishedTool,
  type RunStats,
  type VersionSummary,
} from '@tooldrop/db';
import {
  addLogin as saveLogin,
  checkMailbox,
  parseInboundSms,
  readSealed,
  SmsInbox,
  type SmsCodes,
  Vault,
  verifySmsRequest,
  viewLogins,
  writeSealed,
  type KeyStore,
  type MailboxConfig,
} from '@tooldrop/auth';
import { Runtime, type RunnableTool, type RunOutcome } from '@tooldrop/runtime';
import { Approvals } from './approvals.ts';
import { exportFiles, type ExportRuntime } from './export.ts';
import { Builds, type BuildOptions, type JobView } from './builds.ts';
import { readRecording, writeRecording } from './recordings.ts';
import { Heals } from './heals.ts';
import type { JobQueue } from './queue.ts';
import { Sessions, type SignInOptions } from './sessions.ts';
import { Watches, type WatchOptions } from './watches.ts';
import { Workflows } from './workflows.ts';

/** How long a failed call waits for its repair (SPEC, Runtime execution cascade step 7). */
export const HEAL_HOLD_MS = 5 * 60_000;

// What the interfaces (MCP, REST, CLI) call: tools, recordings, builds,
// logins, heals and watches.

/** A run as the run log shows it (SPEC, runs table). */
export interface RunView {
  id: string;
  tool: string;
  version: number;
  strategy: string;
  duration_ms: number;
  ok: boolean;
  error_code: string | null;
  healed: boolean;
  heal_job_id: string | null;
  created_at: string;
}

/** One build or heal in a tool's history, with what it cost in model time. */
export interface ToolJobView {
  id: string;
  kind: 'build' | 'heal';
  status: string;
  /** For a heal: what started it (failure, fast_path or drift). */
  trigger?: string;
  /** The version it published, when it did. */
  version?: number;
  /** Why: a heal's reason, or a failed job's error. */
  reason?: string;
  usage: JobUsage;
  created_at: string;
}

/** What the transparency dashboard shows for a tool (SPEC, Differentiating features). */
export interface ToolStats {
  /** The runs counted are from this many days back. */
  days: number;
  runs: RunStats;
  /** Model use by the tool's builds and heals, all time. */
  model: Record<'builds' | 'heals', JobUsage & { jobs: number }>;
  /** Its builds and heals, newest first. */
  jobs: ToolJobView[];
}

const NO_USAGE: JobUsage = { calls: 0, retries: 0, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 };

/** Who is asking: the tools an API key may use. Local stdio clients get every tool. */
export type Scopes = string[];
const ALL: Scopes = ['*'];

/** Building tools and uploading recordings change what every key can see, so they need full access. */
export function requireFullAccess(scopes: Scopes): void {
  if (!scopes.includes('*')) {
    throw new ToolDropError('forbidden', 'this needs an API key with access to every tool (scope "*")');
  }
}

export interface EngineOptions {
  db: Db;
  runtime?: Runtime;
  /** Where recordings and captures are kept: ~/.tooldrop locally, /data in the image. */
  dataDir?: string;
  /** Models, browser and queue for builds. */
  builds?: BuildOptions;
  /** Where heal jobs wait: in this process (the default), or on Valkey when self-hosted. */
  heals?: { queue?: JobQueue };
  /** How long a failed call waits for its repair (default 5 minutes, SPEC Runtime step 7). */
  healHoldMs?: number;
  /** Repair worn tools after calls that still worked (default true); off for one-shot commands. */
  backgroundHeals?: boolean;
  /** Where the vault's master key lives; the vault opens on first use (SPEC, Authentication). */
  keyStore?: () => Promise<KeyStore>;
  /** The watch scheduler's clock and webhook delivery; tests set them. */
  watches?: WatchOptions;
  /** Where forwarded SMS codes wait: in this process (the default), or on Valkey when self-hosted. */
  sms?: SmsCodes;
  /** The bundled runtime that code exports carry; without it, this engine cannot export tools. */
  exportRuntime?: () => Promise<ExportRuntime>;
}

export class Engine {
  readonly db: Db;
  readonly runtime: Runtime;
  readonly builds: Builds;
  readonly sessions: Sessions;
  readonly heals: Heals;
  readonly watches: Watches;
  readonly approvals: Approvals;
  readonly workflows: Workflows;
  /** SMS codes forwarded from the person's phone, for logins waiting on one (SPEC, SMS codes). */
  readonly sms: SmsCodes;
  readonly #healHoldMs: number;
  readonly #backgroundHeals: boolean;
  readonly #dataDir: string | undefined;
  readonly #keyStore: (() => Promise<KeyStore>) | undefined;
  readonly #exportRuntime: (() => Promise<ExportRuntime>) | undefined;
  #vault: Promise<Vault> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options: EngineOptions) {
    this.db = options.db;
    this.runtime = options.runtime ?? new Runtime();
    this.#dataDir = options.dataDir;
    this.#keyStore = options.keyStore;
    this.#exportRuntime = options.exportRuntime;
    this.sms = options.sms ?? new SmsInbox();
    this.builds = new Builds(this, options.builds);
    this.sessions = new Sessions(this, options.builds?.browser ? { browser: options.builds.browser } : {});
    this.heals = new Heals(this, options.heals);
    this.watches = new Watches(this, options.watches);
    this.approvals = new Approvals(this);
    this.workflows = new Workflows(this);
    this.#healHoldMs = options.healHoldMs ?? HEAL_HOLD_MS;
    this.#backgroundHeals = options.backgroundHeals ?? true;
  }

  /** Saves a login, sealed in the vault (SPEC, add_login). Returns only the masked view. */
  async addLogin(input: unknown, scopes: Scopes = ALL): Promise<LoginView> {
    requireFullAccess(scopes);
    return saveLogin(this.db, await this.vault(), input);
  }

  /**
   * Signs in to a site now with its saved login, and keeps the session. For a
   * login whose codes arrive by hand, `ask` gets the code from a person.
   */
  async signIn(site: string, options: SignInOptions = {}, scopes: Scopes = ALL): Promise<boolean> {
    requireFullAccess(scopes);
    return (await this.sessions.ensure(site, { ...options, force: true })) !== undefined;
  }

  /** Saved logins, masked (SPEC, list_logins). */
  async listLogins(scopes: Scopes = ALL, site?: string): Promise<LoginView[]> {
    requireFullAccess(scopes);
    if ((await listLogins(this.db, site ? { site } : {})).length === 0) return [];
    return viewLogins(this.db, await this.vault(), site ? { site } : {});
  }

  /** Starts a build job (SPEC, build_tool and POST /v1/builds); poll it with getJob. */
  async startBuild(input: unknown, scopes: Scopes = ALL): Promise<JobView> {
    requireFullAccess(scopes);
    return this.builds.start(input);
  }

  /**
   * Starts a discover job (SPEC, URL-first discovery and discover_tools): a URL
   * only, and the job proposes tools to build. Poll it with getJob.
   */
  async startDiscover(input: unknown, scopes: Scopes = ALL): Promise<JobView> {
    requireFullAccess(scopes);
    return this.builds.startDiscover(input);
  }

  async getJob(id: string, scopes: Scopes = ALL): Promise<JobView> {
    requireFullAccess(scopes);
    return this.builds.view(id);
  }

  /** Answers a build's clarifying question (SPEC, answer_question). */
  async answerQuestion(
    jobId: string,
    questionId: string,
    answer: string,
    scopes: Scopes = ALL,
  ): Promise<JobView> {
    requireFullAccess(scopes);
    return this.builds.answer(jobId, questionId, answer);
  }

  /** The vault, opened on first use with the master key from the key store. */
  vault(): Promise<Vault> {
    const keyStore = this.#keyStore;
    if (!keyStore) {
      return Promise.reject(
        new ToolDropError('vault_unavailable', 'this engine has no key store for the vault'),
      );
    }
    this.#vault ??= keyStore().then((store) => Vault.open(store));
    // A failed open is not kept, so the next call tries again.
    this.#vault.catch(() => (this.#vault = undefined));
    return this.#vault;
  }

  get dataDir(): string {
    if (!this.#dataDir) throw new ToolDropError('internal', 'this engine has no data directory');
    return this.#dataDir;
  }

  /** Stores an uploaded recording for a later build (SPEC, POST /v1/recordings). */
  saveRecording(recording: unknown, scopes: Scopes = ALL): { id: string } {
    requireFullAccess(scopes);
    return { id: writeRecording(this.dataDir, recording).id };
  }

  getRecording(id: string): Recording {
    return readRecording(this.dataDir, id);
  }

  async listTools(scopes: Scopes = ALL): Promise<PublishedTool[]> {
    return (await listTools(this.db)).filter((tool) => keyAllows(scopes, tool.name));
  }

  async findTools(query: { site?: string; task?: string }, scopes: Scopes = ALL): Promise<PublishedTool[]> {
    return (await findTools(this.db, query)).filter((tool) => keyAllows(scopes, tool.name));
  }

  /** Publishes a tool file for a site, as a new tool or its next version. */
  async publish(
    file: ToolFile,
    site: string,
    options: {
      created_by?: RecipeOrigin;
      change_reason?: string;
      test_inputs?: Record<string, unknown>[];
    } = {},
  ): Promise<PublishedTool> {
    const { recipe, ...definition } = file;
    if (await getWorkflow(this.db, definition.name)) {
      throw new ToolDropError(
        'invalid_input',
        `a workflow is named ${definition.name}; give the tool another name`,
      );
    }
    const published = await publishTool(this.db, {
      site,
      definition,
      recipe,
      created_by: options.created_by ?? 'user',
      ...(options.change_reason !== undefined && { change_reason: options.change_reason }),
      ...(options.test_inputs && { test_inputs: options.test_inputs }),
    });
    this.toolsChanged();
    return published;
  }

  /** A tool's versions, oldest first, with who made each and why: its history and heal log. */
  async versions(name: string, scopes: Scopes = ALL): Promise<VersionSummary[]> {
    requireFullAccess(scopes);
    return listVersions(this.db, name);
  }

  /** Makes an earlier version current again, exactly as it was (SPEC, Rollback). */
  async rollback(name: string, version: number, scopes: Scopes = ALL): Promise<PublishedTool> {
    requireFullAccess(scopes);
    const published = await rollbackTool(this.db, name, version);
    this.toolsChanged();
    return published;
  }

  /**
   * Runs a published tool by name and records how it went. Results are never
   * stored, only the run's metadata.
   */
  async runTool(name: string, input: unknown, scopes: Scopes = ALL): Promise<RunOutcome> {
    const tool = await getTool(this.db, name);
    if (!tool || tool.status === 'disabled') throw new ToolDropError('not_found', `no tool named ${name}`);
    if (!keyAllows(scopes, name)) throw new ToolDropError('forbidden', `this API key may not run ${name}`);
    // A write previews and waits for an approval; it is never healed, since a repair replays it (SPEC, Safe mode).
    if (tool.authority === 'write') return this.approvals.call(tool, input);

    let outcome: RunOutcome;
    try {
      outcome = await this.#run(tool, input);
    } catch (error) {
      if (!(error instanceof ToolDropError && error.code === 'strategy_failed')) throw error;
      // Every strategy failed: repair the recipe while the call waits (SPEC, Runtime step 7).
      const healJob = await this.heals.start(tool, { kind: 'failure', error: error.toJSON() });
      const ended = healJob ? await this.heals.wait(healJob, this.#healHoldMs) : 'failed';
      // Only calls that reached the site are runs; bad input or a refused write is not.
      const failed = {
        tool_id: tool.id,
        recipe_version: tool.version,
        strategy_used: tool.recipe.fallback?.strategy ?? tool.recipe.strategy,
        duration_ms: 0,
        ok: false,
        error_code: error.code,
        heal_job_id: healJob ?? null,
      };
      if (ended !== 'healed' || !healJob) {
        await recordRun(this.db, failed);
        if (ended === 'timeout' && healJob) {
          throw new ToolDropError(
            'heal_timeout',
            `${name} is being repaired, and the repair did not finish within ${Math.round(this.#healHoldMs / 60_000)} minutes; check heal job ${healJob}`,
            { details: { heal_job_id: healJob } },
          );
        }
        throw healJob
          ? new ToolDropError(
              'strategy_failed',
              `${error.message}. The repair failed too: see heal job ${healJob}`,
              {
                details: { ...error.details, heal_job_id: healJob },
              },
            )
          : error;
      }
      const healed = await getTool(this.db, name);
      if (!healed) throw error;
      outcome = await this.#run(healed, input);
      outcome.meta.healed = true;
      await recordRun(this.db, {
        tool_id: healed.id,
        recipe_version: healed.version,
        strategy_used: outcome.meta.strategy,
        duration_ms: outcome.meta.duration_ms,
        ok: true,
        healed: true,
        heal_job_id: healJob,
      });
      return outcome;
    }
    await recordRun(this.db, {
      tool_id: tool.id,
      recipe_version: tool.version,
      strategy_used: outcome.meta.strategy,
      duration_ms: outcome.meta.duration_ms,
      ok: true,
    });
    // The call worked, but something wore out: repair it in the background (SPEC, Self-healing).
    // A repair that cannot start never fails the call.
    const fastPath = outcome.attempts[0];
    if (!this.#backgroundHeals) return outcome;
    if (tool.recipe.fallback && fastPath && !fastPath.ok && outcome.meta.strategy === 'browser_script') {
      const error = fastPath.error?.message ?? 'it failed';
      await this.heals.start(tool, { kind: 'fast_path', error }).catch(() => undefined);
    } else if (outcome.drift) {
      await this.heals.start(tool, { kind: 'drift', drift: outcome.drift }).catch(() => undefined);
    }
    return outcome;
  }

  /** A tool as the runtime runs it, signed in when its site has a login; `renew` signs in again. */
  async prepare(tool: PublishedTool, options: { renew?: boolean } = {}): Promise<RunnableTool> {
    const signedIn = await this.sessions.ensure(tool.site.origin, options.renew ? { force: true } : {});
    return {
      name: tool.name,
      authority: tool.authority,
      input_schema: tool.input_schema,
      output_schema: tool.output_schema,
      version: tool.version,
      recipe: tool.recipe,
      site: tool.site.origin,
      rate_limit: tool.site.rate_limit,
      ...(signedIn && { login: { url: signedIn.loginUrl } }),
    };
  }

  /** Runs a tool's current version, signed in when its site has a login. */
  async #run(tool: PublishedTool, input: unknown): Promise<RunOutcome> {
    const runnable = await this.prepare(tool);
    try {
      return await this.runtime.run(runnable, input);
    } catch (error) {
      // An expired session signs in again, then the call runs once more (SPEC, Sessions).
      if (!runnable.login || !(error instanceof ToolDropError && error.code === 'session_expired'))
        throw error;
      return this.runtime.run(await this.prepare(tool, { renew: true }), input);
    }
  }

  /**
   * Runs every tool's saved test inputs (SPEC, Self-healing: a daily health
   * check). A failing tool goes through the same repair as a failing call.
   */
  async healthCheck(
    scopes: Scopes = ALL,
  ): Promise<{ tool: string; ok: boolean; healed: boolean; error?: string }[]> {
    requireFullAccess(scopes);
    const results: { tool: string; ok: boolean; healed: boolean; error?: string }[] = [];
    // Write tools are left out: running one, even as a test, asks for an approval.
    for (const tool of (await this.listTools()).filter((candidate) => candidate.authority === 'read')) {
      const inputs = await testInputs(this.db, tool.id, tool.version);
      if (inputs.length === 0) continue;
      let healed = false;
      try {
        for (const input of inputs) healed = (await this.runTool(tool.name, input)).meta.healed || healed;
        results.push({ tool: tool.name, ok: true, healed });
      } catch (error) {
        results.push({
          tool: tool.name,
          ok: false,
          healed,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  /** Watches a read tool and sends its changes to a webhook (SPEC, create_watch and POST /v1/watches). */
  createWatch(input: unknown, scopes: Scopes = ALL): Promise<{ watch: WatchView; secret: string }> {
    return this.watches.create(input, scopes);
  }

  listWatches(scopes: Scopes = ALL): Promise<WatchView[]> {
    return this.watches.list(scopes);
  }

  deleteWatch(id: string, scopes: Scopes = ALL): Promise<void> {
    return this.watches.delete(id, scopes);
  }

  /**
   * Approves or rejects a pending write (SPEC, approve_action and POST
   * /v1/approvals/:id). `by` names who decided, for the audit log.
   */
  decideApproval(
    id: string,
    decision: unknown,
    scopes: Scopes = ALL,
    by = 'local',
  ): Promise<{ approval: ApprovalView; result?: unknown; meta?: RunOutcome['meta'] }> {
    return this.approvals.decide(id, decision, scopes, by);
  }

  getApproval(id: string, scopes: Scopes = ALL): Promise<ApprovalView> {
    return this.approvals.get(id, scopes);
  }

  /** The write audit log, newest first. */
  listApprovals(scopes: Scopes = ALL, status?: ApprovalView['status']): Promise<ApprovalView[]> {
    return this.approvals.list(scopes, status ? { status } : {});
  }

  approvalScreenshot(
    id: string,
    which: 'before' | 'after',
    scopes: Scopes = ALL,
  ): Promise<Buffer | undefined> {
    return this.approvals.screenshot(id, which, scopes);
  }

  createPolicy(input: unknown, scopes: Scopes = ALL): Promise<PolicyView> {
    return this.approvals.createPolicy(input, scopes);
  }

  listPolicies(scopes: Scopes = ALL): Promise<PolicyView[]> {
    return this.approvals.listPolicies(scopes);
  }

  deletePolicy(id: string, scopes: Scopes = ALL): Promise<void> {
    return this.approvals.deletePolicy(id, scopes);
  }

  /** One published tool, when the key may use it. */
  async getTool(name: string, scopes: Scopes = ALL): Promise<PublishedTool> {
    const tool = await getTool(this.db, name);
    if (!tool || tool.status === 'disabled' || !keyAllows(scopes, name)) {
      throw new ToolDropError('not_found', `no tool named ${name}`);
    }
    return tool;
  }

  /**
   * A tool as a standalone npm package, by file path (SPEC, Code export). A
   * signed-in site's package gets the steps that sign in, never the login.
   */
  async exportTool(name: string, scopes: Scopes = ALL): Promise<Record<string, string>> {
    requireFullAccess(scopes);
    const tool = await this.getTool(name, scopes);
    if (!this.#exportRuntime) throw new ToolDropError('internal', 'this toolDrop cannot export tools');
    const origin = tool.site.origin;
    const login = await siteLogin(this.db, origin);
    const loginRecipe = login ? await getLoginRecipe(this.db, origin) : undefined;
    if (login && !loginRecipe) {
      throw new ToolDropError(
        'invalid_input',
        `${name} signs in to ${origin}, and toolDrop has not signed in there yet; run \`tooldrop logins verify ${origin}\` first`,
      );
    }
    return exportFiles(tool, loginRecipe, await this.#exportRuntime());
  }

  /** One version of a tool with its recipe, to compare versions (SPEC, Transparency dashboard). */
  async version(
    name: string,
    version: number,
    scopes: Scopes = ALL,
  ): Promise<VersionSummary & { recipe: Recipe }> {
    requireFullAccess(scopes);
    return getVersion(this.db, name, version);
  }

  /**
   * A tool's transparency figures: how its calls went over the last `days`,
   * and its builds and heals with their model use. Builds and heals are
   * full-access information, like the versions.
   */
  async toolStats(name: string, scopes: Scopes = ALL, options: { days?: number } = {}): Promise<ToolStats> {
    requireFullAccess(scopes);
    const tool = await getTool(this.db, name);
    if (!tool) throw new ToolDropError('not_found', `no tool named ${name}`);
    const days = options.days ?? 30;
    const runs = await runStats(this.db, tool.id, new Date(Date.now() - days * 86_400_000));
    const jobs = await toolJobs(this.db, name);
    const usage = await usageByJob(
      this.db,
      jobs.map((job) => job.id),
    );
    const model = { builds: { ...NO_USAGE, jobs: 0 }, heals: { ...NO_USAGE, jobs: 0 } };
    const views = jobs.map((job): ToolJobView => {
      const used = usage.get(job.id) ?? NO_USAGE;
      const total = job.kind === 'heal' ? model.heals : model.builds;
      total.jobs += 1;
      for (const key of Object.keys(NO_USAGE) as (keyof JobUsage)[]) total[key] += used[key];
      const result = (job.result ?? {}) as { version?: number; reason?: string };
      const trigger = (job.input as { trigger?: { kind?: string } } | null)?.trigger?.kind;
      const error = (job.error as { message?: string } | null)?.message;
      const reason = result.reason ?? error;
      return {
        id: job.id,
        kind: job.kind === 'heal' ? 'heal' : 'build',
        status: job.status,
        ...(trigger && { trigger }),
        ...(result.version !== undefined && { version: result.version }),
        ...(reason && { reason }),
        usage: used,
        created_at: job.created_at.toISOString(),
      };
    });
    return { days, runs, model, jobs: views };
  }

  /** The run log, newest first: how each call went, never its result. */
  async listRuns(scopes: Scopes = ALL, options: { tool?: string; limit?: number } = {}): Promise<RunView[]> {
    return (await listRuns(this.db, options))
      .filter((run) => keyAllows(scopes, run.tool))
      .map((run) => ({
        id: run.id,
        tool: run.tool,
        version: run.recipe_version,
        strategy: run.strategy_used,
        duration_ms: run.duration_ms,
        ok: run.ok,
        error_code: run.error_code,
        healed: run.healed,
        heal_job_id: run.heal_job_id,
        created_at: run.created_at.toISOString(),
      }));
  }

  /** Recent jobs, newest first: builds and heals, e.g. those waiting for an answer. */
  async listJobs(
    scopes: Scopes = ALL,
    options: { status?: JobStatus; kind?: JobKind; limit?: number } = {},
  ): Promise<JobView[]> {
    requireFullAccess(scopes);
    const jobs = await listJobs(this.db, options);
    return Promise.all(jobs.map((job) => this.builds.view(job.id)));
  }

  /**
   * Turns SMS codes on: creates the webhook's secret, sealed in the vault,
   * or returns the one there is. The person gives it to the forwarder app.
   */
  async enableSms(scopes: Scopes = ALL): Promise<string> {
    requireFullAccess(scopes);
    const vault = await this.vault();
    const existing = readSealed(this.#smsSecretPath(), vault);
    if (existing) return existing;
    const secret = randomBytes(24).toString('hex');
    writeSealed(this.#smsSecretPath(), vault, secret);
    return secret;
  }

  /**
   * Saves the inbox email codes are read from, sealed in the vault, once
   * toolDrop has signed in to it (SPEC, 2FA step 2). Errors name no values.
   */
  async connectMailbox(input: unknown, scopes: Scopes = ALL): Promise<{ host: string; user: string }> {
    requireFullAccess(scopes);
    const parsed = connectMailboxSchema.safeParse(input);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'mailbox'))];
      throw new ToolDropError('invalid_input', `the mailbox is not valid; check ${fields.join(', ')}`);
    }
    await checkMailbox(parsed.data);
    writeSealed(this.#mailboxPath(), await this.vault(), JSON.stringify(parsed.data));
    return { host: parsed.data.host, user: parsed.data.user };
  }

  /** The saved inbox for email codes, when there is one. */
  async mailbox(): Promise<MailboxConfig | undefined> {
    if (!this.#dataDir || !existsSync(this.#mailboxPath())) return undefined;
    const sealed = readSealed(this.#mailboxPath(), await this.vault());
    return sealed ? (JSON.parse(sealed) as MailboxConfig) : undefined;
  }

  #mailboxPath(): string {
    return join(this.dataDir, 'secrets', 'mailbox');
  }

  /** Whether SMS codes are on: a webhook secret exists. */
  smsEnabled(): boolean {
    return this.#dataDir !== undefined && existsSync(this.#smsSecretPath());
  }

  /**
   * Takes a forwarded SMS (POST /v1/sms/inbound). Only a request signed with
   * the secret, or carrying it as a bearer token, counts; stale and repeated
   * messages are refused. The text is never kept.
   */
  async receiveSms(
    rawBody: string,
    headers: { signature?: string | undefined; authorization?: string | undefined },
  ): Promise<'accepted'> {
    const vault = this.smsEnabled() ? await this.vault() : undefined;
    const secret = vault && readSealed(this.#smsSecretPath(), vault);
    if (!secret || !verifySmsRequest(secret, rawBody, headers)) {
      throw new ToolDropError('unauthorized', 'this request is not signed with the SMS secret');
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ToolDropError('invalid_input', 'the body is not JSON');
    }
    const message = parseInboundSms(body);
    if (!message) throw new ToolDropError('invalid_input', 'the body has no "from" and "text"');
    const outcome = await this.sms.accept(message);
    if (outcome === 'stale')
      throw new ToolDropError('invalid_input', 'the message is more than 5 minutes old');
    if (outcome === 'duplicate') throw new ToolDropError('conflict', 'this message was received already');
    return outcome;
  }

  #smsSecretPath(): string {
    return join(this.dataDir, 'secrets', 'sms-secret');
  }

  /** Tells every listener that the tools changed: a publish, a rollback, a workflow saved or removed. */
  toolsChanged(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Saves a workflow file: tools on any sites chained into one (SPEC, Multi-site workflows). */
  saveWorkflow(input: unknown, scopes: Scopes = ALL): Promise<WorkflowView> {
    return this.workflows.save(input, scopes);
  }

  listWorkflows(scopes: Scopes = ALL): Promise<WorkflowView[]> {
    return this.workflows.list(scopes);
  }

  getWorkflow(name: string, scopes: Scopes = ALL): Promise<WorkflowView> {
    return this.workflows.get(name, scopes);
  }

  deleteWorkflow(name: string, scopes: Scopes = ALL): Promise<void> {
    return this.workflows.delete(name, scopes);
  }

  /** Starts a workflow run, a job: poll it with getJob, and answer it when a write asks for approval. */
  runWorkflow(name: string, input: unknown, scopes: Scopes = ALL): Promise<JobView> {
    return this.workflows.start(name, input, scopes);
  }

  /** Calls `listener` whenever the published tools change, e.g. to send MCP's list_changed. */
  onToolsChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.watches.stop();
    await this.builds.close();
    await this.heals.close();
    await this.sms.close?.();
    await this.runtime.close();
  }
}

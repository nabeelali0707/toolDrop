import {
  ToolDropError,
  type LoginView,
  type RecipeOrigin,
  type Recording,
  type ToolFile,
  type WatchView,
} from '@tooldrop/core';
import {
  findTools,
  getTool,
  keyAllows,
  listLogins,
  listTools,
  listVersions,
  publishTool,
  recordRun,
  rollbackTool,
  testInputs,
  type Db,
  type PublishedTool,
  type VersionSummary,
} from '@tooldrop/db';
import { addLogin as saveLogin, Vault, viewLogins, type KeyStore } from '@tooldrop/auth';
import { Runtime, type RunnableTool, type RunOutcome } from '@tooldrop/runtime';
import { Builds, type BuildOptions, type JobView } from './builds.ts';
import { readRecording, writeRecording } from './recordings.ts';
import { Heals } from './heals.ts';
import { Sessions, type SignInOptions } from './sessions.ts';
import { Watches, type WatchOptions } from './watches.ts';

/** How long a failed call waits for its repair (SPEC, Runtime execution cascade step 7). */
export const HEAL_HOLD_MS = 5 * 60_000;

// What the interfaces (MCP, REST, CLI) call: tools, recordings, builds,
// logins, heals and watches.

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
  /** Models and browser for builds. */
  builds?: BuildOptions;
  /** How long a failed call waits for its repair (default 5 minutes, SPEC Runtime step 7). */
  healHoldMs?: number;
  /** Repair worn tools after calls that still worked (default true); off for one-shot commands. */
  backgroundHeals?: boolean;
  /** Where the vault's master key lives; the vault opens on first use (SPEC, Authentication). */
  keyStore?: () => Promise<KeyStore>;
  /** The watch scheduler's clock and webhook delivery; tests set them. */
  watches?: WatchOptions;
}

export class Engine {
  readonly db: Db;
  readonly runtime: Runtime;
  readonly builds: Builds;
  readonly sessions: Sessions;
  readonly heals: Heals;
  readonly watches: Watches;
  readonly #healHoldMs: number;
  readonly #backgroundHeals: boolean;
  readonly #dataDir: string | undefined;
  readonly #keyStore: (() => Promise<KeyStore>) | undefined;
  #vault: Promise<Vault> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options: EngineOptions) {
    this.db = options.db;
    this.runtime = options.runtime ?? new Runtime();
    this.#dataDir = options.dataDir;
    this.#keyStore = options.keyStore;
    this.builds = new Builds(this, options.builds);
    this.sessions = new Sessions(this, options.builds?.browser ? { browser: options.builds.browser } : {});
    this.heals = new Heals(this);
    this.watches = new Watches(this, options.watches);
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
    if (listLogins(this.db, site ? { site } : {}).length === 0) return [];
    return viewLogins(this.db, await this.vault(), site ? { site } : {});
  }

  /** Starts a build job (SPEC, build_tool and POST /v1/builds); poll it with getJob. */
  startBuild(input: unknown, scopes: Scopes = ALL): JobView {
    requireFullAccess(scopes);
    return this.builds.start(input);
  }

  getJob(id: string, scopes: Scopes = ALL): JobView {
    requireFullAccess(scopes);
    return this.builds.view(id);
  }

  /** Answers a build's clarifying question (SPEC, answer_question). */
  answerQuestion(jobId: string, questionId: string, answer: string, scopes: Scopes = ALL): JobView {
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

  listTools(scopes: Scopes = ALL): PublishedTool[] {
    return listTools(this.db).filter((tool) => keyAllows(scopes, tool.name));
  }

  findTools(query: { site?: string; task?: string }, scopes: Scopes = ALL): PublishedTool[] {
    return findTools(this.db, query).filter((tool) => keyAllows(scopes, tool.name));
  }

  /** Publishes a tool file for a site, as a new tool or its next version. */
  publish(
    file: ToolFile,
    site: string,
    options: {
      created_by?: RecipeOrigin;
      change_reason?: string;
      test_inputs?: Record<string, unknown>[];
    } = {},
  ): PublishedTool {
    const { recipe, ...definition } = file;
    const published = publishTool(this.db, {
      site,
      definition,
      recipe,
      created_by: options.created_by ?? 'user',
      ...(options.change_reason !== undefined && { change_reason: options.change_reason }),
      ...(options.test_inputs && { test_inputs: options.test_inputs }),
    });
    for (const listener of this.#listeners) listener();
    return published;
  }

  /** A tool's versions, oldest first, with who made each and why: its history and heal log. */
  versions(name: string, scopes: Scopes = ALL): VersionSummary[] {
    requireFullAccess(scopes);
    return listVersions(this.db, name);
  }

  /** Makes an earlier version current again, exactly as it was (SPEC, Rollback). */
  rollback(name: string, version: number, scopes: Scopes = ALL): PublishedTool {
    requireFullAccess(scopes);
    const published = rollbackTool(this.db, name, version);
    for (const listener of this.#listeners) listener();
    return published;
  }

  /**
   * Runs a published tool by name and records how it went. Results are never
   * stored, only the run's metadata.
   */
  async runTool(name: string, input: unknown, scopes: Scopes = ALL): Promise<RunOutcome> {
    const tool = getTool(this.db, name);
    if (!tool || tool.status === 'disabled') throw new ToolDropError('not_found', `no tool named ${name}`);
    if (!keyAllows(scopes, name)) throw new ToolDropError('forbidden', `this API key may not run ${name}`);

    let outcome: RunOutcome;
    try {
      outcome = await this.#run(tool, input);
    } catch (error) {
      if (!(error instanceof ToolDropError && error.code === 'strategy_failed')) throw error;
      // Every strategy failed: repair the recipe while the call waits (SPEC, Runtime step 7).
      const healJob = this.heals.start(tool, { kind: 'failure', error: error.toJSON() });
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
        recordRun(this.db, failed);
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
      const healed = getTool(this.db, name);
      if (!healed) throw error;
      outcome = await this.#run(healed, input);
      outcome.meta.healed = true;
      recordRun(this.db, {
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
    recordRun(this.db, {
      tool_id: tool.id,
      recipe_version: tool.version,
      strategy_used: outcome.meta.strategy,
      duration_ms: outcome.meta.duration_ms,
      ok: true,
    });
    // The call worked, but something wore out: repair it in the background (SPEC, Self-healing).
    const fastPath = outcome.attempts[0];
    if (!this.#backgroundHeals) return outcome;
    if (tool.recipe.fallback && fastPath && !fastPath.ok && outcome.meta.strategy === 'browser_script') {
      this.heals.start(tool, { kind: 'fast_path', error: fastPath.error?.message ?? 'it failed' });
    } else if (outcome.drift) {
      this.heals.start(tool, { kind: 'drift', drift: outcome.drift });
    }
    return outcome;
  }

  /** Runs a tool's current version, signed in when its site has a login. */
  async #run(tool: PublishedTool, input: unknown): Promise<RunOutcome> {
    const signedIn = await this.sessions.ensure(tool.site.origin);
    const runnable: RunnableTool = {
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
    try {
      return await this.runtime.run(runnable, input);
    } catch (error) {
      // An expired session signs in again, then the call runs once more (SPEC, Sessions).
      if (!signedIn || !(error instanceof ToolDropError && error.code === 'session_expired')) throw error;
      await this.sessions.ensure(tool.site.origin, { force: true });
      return this.runtime.run(runnable, input);
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
    for (const tool of this.listTools()) {
      const inputs = testInputs(this.db, tool.id, tool.version);
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

  listWatches(scopes: Scopes = ALL): WatchView[] {
    return this.watches.list(scopes);
  }

  deleteWatch(id: string, scopes: Scopes = ALL): void {
    this.watches.delete(id, scopes);
  }

  /** Calls `listener` whenever the published tools change, e.g. to send MCP's list_changed. */
  onToolsChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.watches.stop();
    await this.runtime.close();
  }
}

import {
  ToolDropError,
  type LoginView,
  type RecipeOrigin,
  type Recording,
  type ToolFile,
} from '@tooldrop/core';
import {
  findTools,
  getTool,
  keyAllows,
  listLogins,
  listTools,
  publishTool,
  recordRun,
  type Db,
  type PublishedTool,
} from '@tooldrop/db';
import { addLogin as saveLogin, Vault, viewLogins, type KeyStore } from '@tooldrop/auth';
import { Runtime, type RunnableTool, type RunOutcome } from '@tooldrop/runtime';
import { Builds, type BuildOptions, type JobView } from './builds.ts';
import { readRecording, writeRecording } from './recordings.ts';
import { Sessions, type SignInOptions } from './sessions.ts';

// What the interfaces (MCP, REST, CLI) call: tools, recordings and builds.
// Heals and watches join this class in later phases.

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
  /** Where the vault's master key lives; the vault opens on first use (SPEC, Authentication). */
  keyStore?: () => Promise<KeyStore>;
}

export class Engine {
  readonly db: Db;
  readonly runtime: Runtime;
  readonly builds: Builds;
  readonly sessions: Sessions;
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

  /**
   * Runs a published tool by name and records how it went. Results are never
   * stored, only the run's metadata.
   */
  async runTool(name: string, input: unknown, scopes: Scopes = ALL): Promise<RunOutcome> {
    const tool = getTool(this.db, name);
    if (!tool || tool.status === 'disabled') throw new ToolDropError('not_found', `no tool named ${name}`);
    if (!keyAllows(scopes, name)) throw new ToolDropError('forbidden', `this API key may not run ${name}`);

    try {
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
      let outcome: RunOutcome;
      try {
        outcome = await this.runtime.run(runnable, input);
      } catch (error) {
        // An expired session signs in again, then the call runs once more (SPEC, Sessions).
        if (!signedIn || !(error instanceof ToolDropError && error.code === 'session_expired')) throw error;
        await this.sessions.ensure(tool.site.origin, { force: true });
        outcome = await this.runtime.run(runnable, input);
      }
      recordRun(this.db, {
        tool_id: tool.id,
        recipe_version: tool.version,
        strategy_used: outcome.meta.strategy,
        duration_ms: outcome.meta.duration_ms,
        ok: true,
      });
      return outcome;
    } catch (error) {
      // Only calls that reached the site are runs; bad input or a refused write is not.
      if (error instanceof ToolDropError && error.code === 'strategy_failed') {
        recordRun(this.db, {
          tool_id: tool.id,
          recipe_version: tool.version,
          strategy_used: tool.recipe.fallback?.strategy ?? tool.recipe.strategy,
          duration_ms: 0,
          ok: false,
          error_code: error.code,
        });
      }
      throw error;
    }
  }

  /** Calls `listener` whenever the published tools change, e.g. to send MCP's list_changed. */
  onToolsChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }
}

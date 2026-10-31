import {
  APPROVAL_STATUSES,
  AUTHORITIES,
  JOB_KINDS,
  JOB_STATUSES,
  LLM_PROVIDERS,
  LLM_ROLES,
  LOGIN_STATUSES,
  POLICY_OPERATORS,
  RECIPE_ORIGINS,
  ROLES,
  STRATEGIES,
  TOOL_STATUSES,
  TWOFA_METHODS,
  type ApprovalView,
  type JobAnswer,
  type JobQuestion,
  type JsonSchema,
  type LoginRecipe,
  type Step,
  type TwofaConfig,
  type WorkflowStep,
  type WritePreview,
} from '@tooldrop/core';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// The tables from SPEC's data model. Column types are chosen to port to
// Postgres unchanged (DECISIONS.md, D-015): text ULIDs, JSON stored as text,
// timestamps as integer milliseconds, and no SQLite-only features.

const timestamps = {
  created_at: integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

/** A CHECK constraint that keeps an enum column to its values. */
function oneOf(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  const list = values.map((value) => `'${value}'`).join(', ');
  return check(name, sql`${column} in (${sql.raw(list)})`);
}

export interface RateLimit {
  per_second: number;
  concurrency: number;
}

export const sites = sqliteTable(
  'sites',
  {
    id: text().primaryKey(),
    origin: text().notNull(),
    name: text().notNull(),
    login_recipe_id: text(),
    approved_auth_origins: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    rate_limit: text({ mode: 'json' })
      .$type<RateLimit>()
      .notNull()
      .default({ per_second: 1, concurrency: 2 }),
    notes: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex('sites_origin_unique').on(t.origin)],
);

export const logins = sqliteTable(
  'logins',
  {
    id: text().primaryKey(),
    site_id: text()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    /** Encrypted with the vault's master key; never stored or returned in plain text. */
    encrypted_secret: blob({ mode: 'buffer' }).notNull(),
    /** Null when the site has no second factor. */
    twofa_method: text({ enum: TWOFA_METHODS }),
    twofa_config: text({ mode: 'json' }).$type<TwofaConfig>(),
    status: text({ enum: LOGIN_STATUSES }).notNull().default('unchecked'),
    ...timestamps,
  },
  (t) => [
    index('logins_site_id').on(t.site_id),
    oneOf('logins_twofa_method', t.twofa_method, TWOFA_METHODS),
    oneOf('logins_status', t.status, LOGIN_STATUSES),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    login_id: text()
      .notNull()
      .references(() => logins.id, { onDelete: 'cascade' }),
    /** Playwright storage state (cookies, local storage, tokens), encrypted. */
    storage_state: blob({ mode: 'buffer' }).notNull(),
    expires_at: integer({ mode: 'timestamp_ms' }),
    last_verified_at: integer({ mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [index('sessions_login_id').on(t.login_id)],
);

export const tools = sqliteTable(
  'tools',
  {
    id: text().primaryKey(),
    site_id: text()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull(),
    authority: text({ enum: AUTHORITIES }).notNull(),
    input_schema: text({ mode: 'json' }).$type<JsonSchema>().notNull(),
    output_schema: text({ mode: 'json' }).$type<JsonSchema>().notNull(),
    current_version: integer().notNull(),
    status: text({ enum: TOOL_STATUSES }).notNull().default('live'),
    ...timestamps,
  },
  (t) => [
    // MCP lists every tool by name, so names are unique across sites.
    uniqueIndex('tools_name_unique').on(t.name),
    index('tools_site_id').on(t.site_id),
    oneOf('tools_authority', t.authority, AUTHORITIES),
    oneOf('tools_status', t.status, TOOL_STATUSES),
  ],
);

export const recipe_versions = sqliteTable(
  'recipe_versions',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    strategy: text({ enum: STRATEGIES }).notNull(),
    steps: text({ mode: 'json' }).$type<Step[]>().notNull(),
    /** The browser version of the same tool, used when the primary strategy fails (DECISIONS.md, D-025). */
    fallback: text({ mode: 'json' }).$type<{ strategy: 'browser_script'; steps: Step[] }>(),
    test_inputs: text({ mode: 'json' }).$type<Record<string, unknown>[]>().notNull().default([]),
    created_by: text({ enum: RECIPE_ORIGINS }).notNull(),
    change_reason: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('recipe_versions_tool_version_unique').on(t.tool_id, t.version),
    oneOf('recipe_versions_strategy', t.strategy, STRATEGIES),
    oneOf('recipe_versions_created_by', t.created_by, RECIPE_ORIGINS),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text().primaryKey(),
    kind: text({ enum: JOB_KINDS }).notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default('queued'),
    /** What a running job is doing now, e.g. "analyzing traffic", for get_job. */
    step: text(),
    input: text({ mode: 'json' }).$type<unknown>().notNull(),
    questions: text({ mode: 'json' }).$type<JobQuestion[]>().notNull().default([]),
    answers: text({ mode: 'json' }).$type<JobAnswer[]>().notNull().default([]),
    result: text({ mode: 'json' }).$type<unknown>(),
    error: text({ mode: 'json' }).$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    index('jobs_status').on(t.status),
    oneOf('jobs_kind', t.kind, JOB_KINDS),
    oneOf('jobs_status_values', t.status, JOB_STATUSES),
  ],
);

/** One row per tool call. Results are never stored, only how the call went. */
export const runs = sqliteTable(
  'runs',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    recipe_version: integer().notNull(),
    strategy_used: text({ enum: STRATEGIES }).notNull(),
    duration_ms: integer().notNull(),
    ok: integer({ mode: 'boolean' }).notNull(),
    error_code: text(),
    healed: integer({ mode: 'boolean' }).notNull().default(false),
    /** The heal this call waited on (DECISIONS.md, D-013). */
    heal_job_id: text().references(() => jobs.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('runs_tool_id_created_at').on(t.tool_id, t.created_at),
    oneOf('runs_strategy_used', t.strategy_used, STRATEGIES),
  ],
);

/** One row per model call: token usage and duration instead of cost (DECISIONS.md, D-013). */
export const llm_calls = sqliteTable(
  'llm_calls',
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    provider: text({ enum: LLM_PROVIDERS }).notNull(),
    model: text().notNull(),
    role: text({ enum: LLM_ROLES }).notNull(),
    /** What the call was for, e.g. "write_recipe". */
    purpose: text(),
    prompt_tokens: integer().notNull(),
    completion_tokens: integer().notNull(),
    duration_ms: integer().notNull(),
    /** 1 for the first call; each retry after a failed validation adds one. */
    attempt: integer().notNull(),
    /** Whether the reply passed its Zod schema. */
    ok: integer({ mode: 'boolean' }).notNull(),
    error_code: text(),
    ...timestamps,
  },
  (t) => [
    index('llm_calls_job_id').on(t.job_id),
    oneOf('llm_calls_provider', t.provider, LLM_PROVIDERS),
    oneOf('llm_calls_role', t.role, LLM_ROLES),
  ],
);

export const watches = sqliteTable(
  'watches',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    inputs: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    interval_s: integer().notNull(),
    key_field: text().notNull(),
    webhook_url: text().notNull(),
    /** HMAC key for signing webhooks, encrypted like every secret. */
    secret: blob({ mode: 'buffer' }).notNull(),
    /** Hash of the whole last result, to skip the diff when nothing changed. */
    last_snapshot_hash: text(),
    /** Hash of each row of the last result, by key. The rows themselves are never kept. */
    row_hashes: text({ mode: 'json' }).$type<Record<string, string>>(),
    /** When the next run is due; null means now. */
    next_run_at: integer({ mode: 'timestamp_ms' }),
    /** Set while a process runs the watch, so another one sharing the database leaves it alone. */
    lease_until: integer({ mode: 'timestamp_ms' }),
    last_run_at: integer({ mode: 'timestamp_ms' }),
    /** Why the last run or delivery failed, until one works. */
    last_error: text(),
    ...timestamps,
  },
  (t) => [
    index('watches_tool_id').on(t.tool_id),
    // SPEC: watches run at most every 5 minutes.
    check('watches_min_interval', sql`${t.interval_s} >= 300`),
  ],
);

/**
 * A write waiting for a decision, and once decided, its record: the write
 * audit log (SPEC, Safe mode). Screenshots are files in the data directory.
 */
export const approvals = sqliteTable(
  'approvals',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    /** The previewed version; only it may run the write. */
    version: integer().notNull(),
    inputs: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    preview: text({ mode: 'json' }).$type<WritePreview>().notNull(),
    /** The filled form, before the write. */
    screenshot_path: text(),
    status: text({ enum: APPROVAL_STATUSES }).notNull().default('pending'),
    decided_by: text(),
    decided_at: integer({ mode: 'timestamp_ms' }),
    expires_at: integer({ mode: 'timestamp_ms' }).notNull(),
    /** The run that made the write, once approved. */
    run_id: text().references(() => runs.id, { onDelete: 'set null' }),
    /** The page after the write. */
    after_screenshot_path: text(),
    outcome: text({ mode: 'json' }).$type<ApprovalView['outcome']>(),
    ...timestamps,
  },
  (t) => [
    index('approvals_tool_id').on(t.tool_id),
    index('approvals_status').on(t.status),
    oneOf('approvals_status_values', t.status, APPROVAL_STATUSES),
  ],
);

/** Rules that approve a tool's writes by themselves, e.g. amount < 100 (SPEC, Safe mode). */
export const approval_policies = sqliteTable(
  'approval_policies',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    field: text().notNull(),
    op: text({ enum: POLICY_OPERATORS }).notNull(),
    value: text({ mode: 'json' }).$type<number | string>().notNull(),
    ...timestamps,
  },
  (t) => [
    index('approval_policies_tool_id').on(t.tool_id),
    oneOf('approval_policies_op', t.op, POLICY_OPERATORS),
  ],
);

/**
 * Bearer keys for the REST API and remote MCP (DECISIONS.md, D-021). Only a
 * SHA-256 hash is stored; the key itself is shown once, when it is created.
 */
export const api_keys = sqliteTable(
  'api_keys',
  {
    id: text().primaryKey(),
    label: text().notNull(),
    key_hash: text().notNull(),
    /** Tool names this key may run, or ["*"] for all. */
    scopes: text({ mode: 'json' }).$type<string[]>().notNull().default(['*']),
    last_used_at: integer({ mode: 'timestamp_ms' }),
    revoked_at: integer({ mode: 'timestamp_ms' }),
    /** The user the key belongs to; a key of no user acts as an admin, as keys did before users. */
    user_id: text().references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('api_keys_key_hash_unique').on(t.key_hash), index('api_keys_user_id').on(t.user_id)],
);

/**
 * Each site's login recipes, versioned like tools; `sites.login_recipe_id`
 * names the one in use (SPEC, Authentication).
 */
export const login_recipes = sqliteTable(
  'login_recipes',
  {
    id: text().primaryKey(),
    site_id: text()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    recipe: text({ mode: 'json' }).$type<LoginRecipe>().notNull(),
    created_by: text({ enum: RECIPE_ORIGINS }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('login_recipes_site_version_unique').on(t.site_id, t.version),
    oneOf('login_recipes_created_by', t.created_by, RECIPE_ORIGINS),
  ],
);

/** Raw evidence from a build or recording. Large files live on disk; rows hold their paths. */
export const captures = sqliteTable(
  'captures',
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    har_path: text().notNull(),
    dom_snapshots: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    ax_trees: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    actions: text({ mode: 'json' }).$type<unknown[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [index('captures_job_id').on(t.job_id)],
);

/** Multi-site workflows: published tools chained into one (SPEC, Differentiating features). */
export const workflows = sqliteTable(
  'workflows',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    authority: text({ enum: AUTHORITIES }).notNull(),
    input_schema: text({ mode: 'json' }).$type<JsonSchema>().notNull(),
    steps: text({ mode: 'json' }).$type<WorkflowStep[]>().notNull(),
    output: text({ mode: 'json' }).$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('workflows_name_unique').on(t.name),
    oneOf('workflows_authority', t.authority, AUTHORITIES),
  ],
);

/** People who use a self-hosted toolDrop, each with a role (SPEC, Self-hosting). */
export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    role: text({ enum: ROLES }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_name_unique').on(t.name), oneOf('users_role', t.role, ROLES)],
);

/** Who did what over the REST API and remote MCP: never a request's body. */
export const audit_events = sqliteTable(
  'audit_events',
  {
    id: text().primaryKey(),
    actor: text().notNull(),
    action: text().notNull(),
    target: text(),
    status: integer(),
    ...timestamps,
  },
  (t) => [index('audit_events_created_at').on(t.created_at), index('audit_events_actor').on(t.actor)],
);

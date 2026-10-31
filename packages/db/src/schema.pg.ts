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
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { RateLimit } from './schema.ts';

// The same tables as schema.ts, for Postgres when self-hosted (DECISIONS.md,
// D-015 and D-051). Postgres types where they fit (jsonb, timestamptz,
// boolean, bytea) give rows the same TypeScript shape as SQLite's, so one set
// of repository functions serves both. A parity test keeps the two in step.

/** Binary values, such as sealed secrets, as Buffers whichever driver reads them. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

const time = () => timestamp({ mode: 'date', withTimezone: true, precision: 3 });

const timestamps = {
  created_at: time()
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: time()
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
  const list = values.map((value) => `'${value}'`).join(', ');
  return check(name, sql`${column} in (${sql.raw(list)})`);
}

export const sites = pgTable(
  'sites',
  {
    id: text().primaryKey(),
    origin: text().notNull(),
    name: text().notNull(),
    login_recipe_id: text(),
    approved_auth_origins: jsonb().$type<string[]>().notNull().default([]),
    rate_limit: jsonb().$type<RateLimit>().notNull().default({ per_second: 1, concurrency: 2 }),
    notes: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex('sites_origin_unique').on(t.origin)],
);

export const logins = pgTable(
  'logins',
  {
    id: text().primaryKey(),
    site_id: text()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    encrypted_secret: bytea().notNull(),
    twofa_method: text({ enum: TWOFA_METHODS }),
    twofa_config: jsonb().$type<TwofaConfig>(),
    status: text({ enum: LOGIN_STATUSES }).notNull().default('unchecked'),
    ...timestamps,
  },
  (t) => [
    index('logins_site_id').on(t.site_id),
    oneOf('logins_twofa_method', t.twofa_method, TWOFA_METHODS),
    oneOf('logins_status', t.status, LOGIN_STATUSES),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    login_id: text()
      .notNull()
      .references(() => logins.id, { onDelete: 'cascade' }),
    storage_state: bytea().notNull(),
    expires_at: time(),
    last_verified_at: time(),
    ...timestamps,
  },
  (t) => [index('sessions_login_id').on(t.login_id)],
);

export const tools = pgTable(
  'tools',
  {
    id: text().primaryKey(),
    site_id: text()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull(),
    authority: text({ enum: AUTHORITIES }).notNull(),
    input_schema: jsonb().$type<JsonSchema>().notNull(),
    output_schema: jsonb().$type<JsonSchema>().notNull(),
    current_version: integer().notNull(),
    status: text({ enum: TOOL_STATUSES }).notNull().default('live'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tools_name_unique').on(t.name),
    index('tools_site_id').on(t.site_id),
    oneOf('tools_authority', t.authority, AUTHORITIES),
    oneOf('tools_status', t.status, TOOL_STATUSES),
  ],
);

export const recipe_versions = pgTable(
  'recipe_versions',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    strategy: text({ enum: STRATEGIES }).notNull(),
    steps: jsonb().$type<Step[]>().notNull(),
    fallback: jsonb().$type<{ strategy: 'browser_script'; steps: Step[] }>(),
    test_inputs: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
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

export const jobs = pgTable(
  'jobs',
  {
    id: text().primaryKey(),
    kind: text({ enum: JOB_KINDS }).notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default('queued'),
    step: text(),
    input: jsonb().$type<unknown>().notNull(),
    questions: jsonb().$type<JobQuestion[]>().notNull().default([]),
    answers: jsonb().$type<JobAnswer[]>().notNull().default([]),
    result: jsonb().$type<unknown>(),
    error: jsonb().$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    index('jobs_status').on(t.status),
    oneOf('jobs_kind', t.kind, JOB_KINDS),
    oneOf('jobs_status_values', t.status, JOB_STATUSES),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    recipe_version: integer().notNull(),
    strategy_used: text({ enum: STRATEGIES }).notNull(),
    duration_ms: integer().notNull(),
    ok: boolean().notNull(),
    error_code: text(),
    healed: boolean().notNull().default(false),
    heal_job_id: text().references(() => jobs.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('runs_tool_id_created_at').on(t.tool_id, t.created_at),
    oneOf('runs_strategy_used', t.strategy_used, STRATEGIES),
  ],
);

export const llm_calls = pgTable(
  'llm_calls',
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    provider: text({ enum: LLM_PROVIDERS }).notNull(),
    model: text().notNull(),
    role: text({ enum: LLM_ROLES }).notNull(),
    purpose: text(),
    prompt_tokens: integer().notNull(),
    completion_tokens: integer().notNull(),
    duration_ms: integer().notNull(),
    attempt: integer().notNull(),
    ok: boolean().notNull(),
    error_code: text(),
    ...timestamps,
  },
  (t) => [
    index('llm_calls_job_id').on(t.job_id),
    oneOf('llm_calls_provider', t.provider, LLM_PROVIDERS),
    oneOf('llm_calls_role', t.role, LLM_ROLES),
  ],
);

export const watches = pgTable(
  'watches',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    inputs: jsonb().$type<Record<string, unknown>>().notNull(),
    interval_s: integer().notNull(),
    key_field: text().notNull(),
    webhook_url: text().notNull(),
    secret: bytea().notNull(),
    last_snapshot_hash: text(),
    row_hashes: jsonb().$type<Record<string, string>>(),
    next_run_at: time(),
    lease_until: time(),
    last_run_at: time(),
    last_error: text(),
    ...timestamps,
  },
  (t) => [index('watches_tool_id').on(t.tool_id), check('watches_min_interval', sql`${t.interval_s} >= 300`)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    inputs: jsonb().$type<Record<string, unknown>>().notNull(),
    preview: jsonb().$type<WritePreview>().notNull(),
    screenshot_path: text(),
    status: text({ enum: APPROVAL_STATUSES }).notNull().default('pending'),
    decided_by: text(),
    decided_at: time(),
    expires_at: time().notNull(),
    run_id: text().references(() => runs.id, { onDelete: 'set null' }),
    after_screenshot_path: text(),
    outcome: jsonb().$type<ApprovalView['outcome']>(),
    ...timestamps,
  },
  (t) => [
    index('approvals_tool_id').on(t.tool_id),
    index('approvals_status').on(t.status),
    oneOf('approvals_status_values', t.status, APPROVAL_STATUSES),
  ],
);

export const approval_policies = pgTable(
  'approval_policies',
  {
    id: text().primaryKey(),
    tool_id: text()
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    field: text().notNull(),
    op: text({ enum: POLICY_OPERATORS }).notNull(),
    value: jsonb().$type<number | string>().notNull(),
    ...timestamps,
  },
  (t) => [
    index('approval_policies_tool_id').on(t.tool_id),
    oneOf('approval_policies_op', t.op, POLICY_OPERATORS),
  ],
);

export const api_keys = pgTable(
  'api_keys',
  {
    id: text().primaryKey(),
    label: text().notNull(),
    key_hash: text().notNull(),
    scopes: jsonb().$type<string[]>().notNull().default(['*']),
    last_used_at: time(),
    revoked_at: time(),
    user_id: text().references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('api_keys_key_hash_unique').on(t.key_hash), index('api_keys_user_id').on(t.user_id)],
);

export const login_recipes = pgTable(
  'login_recipes',
  {
    id: text().primaryKey(),
    site_id: text()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    recipe: jsonb().$type<LoginRecipe>().notNull(),
    created_by: text({ enum: RECIPE_ORIGINS }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('login_recipes_site_version_unique').on(t.site_id, t.version),
    oneOf('login_recipes_created_by', t.created_by, RECIPE_ORIGINS),
  ],
);

export const captures = pgTable(
  'captures',
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    har_path: text().notNull(),
    dom_snapshots: jsonb().$type<string[]>().notNull().default([]),
    ax_trees: jsonb().$type<string[]>().notNull().default([]),
    actions: jsonb().$type<unknown[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [index('captures_job_id').on(t.job_id)],
);

export const workflows = pgTable(
  'workflows',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    authority: text({ enum: AUTHORITIES }).notNull(),
    input_schema: jsonb().$type<JsonSchema>().notNull(),
    steps: jsonb().$type<WorkflowStep[]>().notNull(),
    output: jsonb().$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('workflows_name_unique').on(t.name),
    oneOf('workflows_authority', t.authority, AUTHORITIES),
  ],
);

/** People who use a self-hosted toolDrop, each with a role (SPEC, Self-hosting). */
export const users = pgTable(
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
export const audit_events = pgTable(
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

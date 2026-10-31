CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"field" text NOT NULL,
	"op" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "approval_policies_op" CHECK ("approval_policies"."op" in ('<', '<=', '>', '>=', '==', '!='))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"version" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"screenshot_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"run_id" text,
	"after_screenshot_path" text,
	"outcome" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "approvals_status_values" CHECK ("approvals"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"har_path" text NOT NULL,
	"dom_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ax_trees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"input" jsonb NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "jobs_kind" CHECK ("jobs"."kind" in ('build', 'heal', 'discover')),
	CONSTRAINT "jobs_status_values" CHECK ("jobs"."status" in ('queued', 'running', 'waiting_for_answer', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"role" text NOT NULL,
	"purpose" text,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"attempt" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "llm_calls_provider" CHECK ("llm_calls"."provider" in ('ollama', 'openai_compatible')),
	CONSTRAINT "llm_calls_role" CHECK ("llm_calls"."role" in ('code', 'reasoning'))
);
--> statement-breakpoint
CREATE TABLE "login_recipes" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"version" integer NOT NULL,
	"recipe" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "login_recipes_created_by" CHECK ("login_recipes"."created_by" in ('build', 'heal', 'user'))
);
--> statement-breakpoint
CREATE TABLE "logins" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_secret" "bytea" NOT NULL,
	"twofa_method" text,
	"twofa_config" jsonb,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "logins_twofa_method" CHECK ("logins"."twofa_method" in ('totp', 'email', 'sms', 'human')),
	CONSTRAINT "logins_status" CHECK ("logins"."status" in ('verified', 'needs_attention', 'unchecked'))
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"version" integer NOT NULL,
	"strategy" text NOT NULL,
	"steps" jsonb NOT NULL,
	"fallback" jsonb,
	"test_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"change_reason" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "recipe_versions_strategy" CHECK ("recipe_versions"."strategy" in ('official_api', 'http_replay', 'html_fetch', 'browser_script')),
	CONSTRAINT "recipe_versions_created_by" CHECK ("recipe_versions"."created_by" in ('build', 'heal', 'user'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"recipe_version" integer NOT NULL,
	"strategy_used" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"healed" boolean DEFAULT false NOT NULL,
	"heal_job_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "runs_strategy_used" CHECK ("runs"."strategy_used" in ('official_api', 'http_replay', 'html_fetch', 'browser_script'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"login_id" text NOT NULL,
	"storage_state" "bytea" NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"last_verified_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"name" text NOT NULL,
	"login_recipe_id" text,
	"approved_auth_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit" jsonb DEFAULT '{"per_second":1,"concurrency":2}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"authority" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"current_version" integer NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "tools_authority" CHECK ("tools"."authority" in ('read', 'write')),
	CONSTRAINT "tools_status" CHECK ("tools"."status" in ('live', 'degraded', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"interval_s" integer NOT NULL,
	"key_field" text NOT NULL,
	"webhook_url" text NOT NULL,
	"secret" "bytea" NOT NULL,
	"last_snapshot_hash" text,
	"row_hashes" jsonb,
	"next_run_at" timestamp (3) with time zone,
	"lease_until" timestamp (3) with time zone,
	"last_run_at" timestamp (3) with time zone,
	"last_error" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "watches_min_interval" CHECK ("watches"."interval_s" >= 300)
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_recipes" ADD CONSTRAINT "login_recipes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" ADD CONSTRAINT "logins_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_heal_job_id_jobs_id_fk" FOREIGN KEY ("heal_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_login_id_logins_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "approval_policies_tool_id" ON "approval_policies" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "approvals_tool_id" ON "approvals" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "approvals_status" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "captures_job_id" ON "captures" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "llm_calls_job_id" ON "llm_calls" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "login_recipes_site_version_unique" ON "login_recipes" USING btree ("site_id","version");--> statement-breakpoint
CREATE INDEX "logins_site_id" ON "logins" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_versions_tool_version_unique" ON "recipe_versions" USING btree ("tool_id","version");--> statement-breakpoint
CREATE INDEX "runs_tool_id_created_at" ON "runs" USING btree ("tool_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_login_id" ON "sessions" USING btree ("login_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_origin_unique" ON "sites" USING btree ("origin");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_name_unique" ON "tools" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tools_site_id" ON "tools" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "watches_tool_id" ON "watches" USING btree ("tool_id");
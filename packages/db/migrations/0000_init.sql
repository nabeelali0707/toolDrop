CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`preview` text NOT NULL,
	`screenshot_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "approvals_status" CHECK("approvals"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `approvals_run_id` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`har_path` text NOT NULL,
	`dom_snapshots` text DEFAULT '[]' NOT NULL,
	`ax_trees` text DEFAULT '[]' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `captures_job_id` ON `captures` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input` text NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`answers` text DEFAULT '[]' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "jobs_kind" CHECK("jobs"."kind" in ('build', 'heal', 'discover')),
	CONSTRAINT "jobs_status_values" CHECK("jobs"."status" in ('queued', 'running', 'waiting_for_answer', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`role` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`attempt` integer NOT NULL,
	`ok` integer NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "llm_calls_provider" CHECK("llm_calls"."provider" in ('ollama', 'openai_compatible')),
	CONSTRAINT "llm_calls_role" CHECK("llm_calls"."role" in ('code', 'reasoning'))
);
--> statement-breakpoint
CREATE INDEX `llm_calls_job_id` ON `llm_calls` (`job_id`);--> statement-breakpoint
CREATE TABLE `logins` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`label` text NOT NULL,
	`encrypted_secret` blob NOT NULL,
	`twofa_method` text,
	`twofa_config` text,
	`status` text DEFAULT 'unchecked' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "logins_twofa_method" CHECK("logins"."twofa_method" in ('totp', 'email', 'sms', 'human')),
	CONSTRAINT "logins_status" CHECK("logins"."status" in ('verified', 'needs_attention', 'unchecked'))
);
--> statement-breakpoint
CREATE INDEX `logins_site_id` ON `logins` (`site_id`);--> statement-breakpoint
CREATE TABLE `recipe_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`version` integer NOT NULL,
	`strategy` text NOT NULL,
	`steps` text NOT NULL,
	`test_inputs` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`change_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recipe_versions_strategy" CHECK("recipe_versions"."strategy" in ('official_api', 'http_replay', 'html_fetch', 'browser_script')),
	CONSTRAINT "recipe_versions_created_by" CHECK("recipe_versions"."created_by" in ('build', 'heal', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_versions_tool_version_unique` ON `recipe_versions` (`tool_id`,`version`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`recipe_version` integer NOT NULL,
	`strategy_used` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error_code` text,
	`healed` integer DEFAULT false NOT NULL,
	`heal_job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`heal_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_strategy_used" CHECK("runs"."strategy_used" in ('official_api', 'http_replay', 'html_fetch', 'browser_script'))
);
--> statement-breakpoint
CREATE INDEX `runs_tool_id_created_at` ON `runs` (`tool_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`login_id` text NOT NULL,
	`storage_state` blob NOT NULL,
	`expires_at` integer,
	`last_verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`login_id`) REFERENCES `logins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_login_id` ON `sessions` (`login_id`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`name` text NOT NULL,
	`login_recipe_id` text,
	`approved_auth_origins` text DEFAULT '[]' NOT NULL,
	`rate_limit` text DEFAULT '{"per_second":1,"concurrency":2}' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_origin_unique` ON `sites` (`origin`);--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`authority` text NOT NULL,
	`input_schema` text NOT NULL,
	`output_schema` text NOT NULL,
	`current_version` integer NOT NULL,
	`status` text DEFAULT 'live' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tools_authority" CHECK("tools"."authority" in ('read', 'write')),
	CONSTRAINT "tools_status" CHECK("tools"."status" in ('live', 'degraded', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tools_name_unique` ON `tools` (`name`);--> statement-breakpoint
CREATE INDEX `tools_site_id` ON `tools` (`site_id`);--> statement-breakpoint
CREATE TABLE `watches` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`inputs` text NOT NULL,
	`interval_s` integer NOT NULL,
	`key_field` text NOT NULL,
	`webhook_url` text NOT NULL,
	`secret` blob NOT NULL,
	`last_snapshot_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "watches_min_interval" CHECK("watches"."interval_s" >= 300)
);
--> statement-breakpoint
CREATE INDEX `watches_tool_id` ON `watches` (`tool_id`);
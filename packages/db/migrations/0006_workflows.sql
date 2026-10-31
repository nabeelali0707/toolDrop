CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`authority` text NOT NULL,
	`input_schema` text NOT NULL,
	`steps` text NOT NULL,
	`output` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "workflows_authority" CHECK("workflows"."authority" in ('read', 'write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_name_unique` ON `workflows` (`name`);--> statement-breakpoint
-- jobs gets the "workflow" kind, which in SQLite means rebuilding the table.
-- Migrations run in one transaction, where PRAGMA foreign_keys cannot be
-- turned off, so dropping jobs would delete the model calls and captures of
-- every job and clear runs' heal jobs. They are kept aside and put back.
CREATE TEMP TABLE `__keep_llm_calls` AS SELECT * FROM `llm_calls`;--> statement-breakpoint
CREATE TEMP TABLE `__keep_captures` AS SELECT * FROM `captures`;--> statement-breakpoint
CREATE TEMP TABLE `__keep_heal_jobs` AS SELECT `id`, `heal_job_id` FROM `runs` WHERE `heal_job_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`step` text,
	`input` text NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`answers` text DEFAULT '[]' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "jobs_kind" CHECK("__new_jobs"."kind" in ('build', 'heal', 'discover', 'workflow')),
	CONSTRAINT "jobs_status_values" CHECK("__new_jobs"."status" in ('queued', 'running', 'waiting_for_answer', 'succeeded', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "kind", "status", "step", "input", "questions", "answers", "result", "error", "created_at", "updated_at") SELECT "id", "kind", "status", "step", "input", "questions", "answers", "result", "error", "created_at", "updated_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
INSERT INTO `llm_calls` SELECT * FROM `__keep_llm_calls` WHERE `id` NOT IN (SELECT `id` FROM `llm_calls`);--> statement-breakpoint
INSERT INTO `captures` SELECT * FROM `__keep_captures` WHERE `id` NOT IN (SELECT `id` FROM `captures`);--> statement-breakpoint
UPDATE `runs` SET `heal_job_id` = (SELECT `heal_job_id` FROM `__keep_heal_jobs` WHERE `__keep_heal_jobs`.`id` = `runs`.`id`) WHERE `id` IN (SELECT `id` FROM `__keep_heal_jobs`);--> statement-breakpoint
DROP TABLE `__keep_llm_calls`;--> statement-breakpoint
DROP TABLE `__keep_captures`;--> statement-breakpoint
DROP TABLE `__keep_heal_jobs`;

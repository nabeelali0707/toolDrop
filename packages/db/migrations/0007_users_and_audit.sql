CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`status` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_created_at` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor` ON `audit_events` (`actor`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_role" CHECK("users"."role" in ('viewer', 'editor', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_name_unique` ON `users` (`name`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `user_id` text REFERENCES `users`(`id`) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `api_keys_user_id` ON `api_keys` (`user_id`);
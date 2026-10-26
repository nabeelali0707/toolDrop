CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text DEFAULT '["*"]' NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
ALTER TABLE `recipe_versions` ADD `fallback` text;
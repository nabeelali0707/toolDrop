CREATE TABLE `login_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`version` integer NOT NULL,
	`recipe` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "login_recipes_created_by" CHECK("login_recipes"."created_by" in ('build', 'heal', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_recipes_site_version_unique` ON `login_recipes` (`site_id`,`version`);
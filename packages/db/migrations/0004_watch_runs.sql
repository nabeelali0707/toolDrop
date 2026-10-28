ALTER TABLE `watches` ADD `row_hashes` text;--> statement-breakpoint
ALTER TABLE `watches` ADD `next_run_at` integer;--> statement-breakpoint
ALTER TABLE `watches` ADD `lease_until` integer;--> statement-breakpoint
ALTER TABLE `watches` ADD `last_run_at` integer;--> statement-breakpoint
ALTER TABLE `watches` ADD `last_error` text;
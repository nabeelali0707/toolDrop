CREATE TABLE `approval_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`field` text NOT NULL,
	`op` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "approval_policies_op" CHECK("approval_policies"."op" in ('<', '<=', '>', '>=', '==', '!='))
);
--> statement-breakpoint
CREATE INDEX `approval_policies_tool_id` ON `approval_policies` (`tool_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`version` integer NOT NULL,
	`inputs` text NOT NULL,
	`preview` text NOT NULL,
	`screenshot_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`expires_at` integer NOT NULL,
	`run_id` text,
	`after_screenshot_path` text,
	`outcome` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "approvals_status_values" CHECK("__new_approvals"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
DROP TABLE `approvals`;--> statement-breakpoint
ALTER TABLE `__new_approvals` RENAME TO `approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `approvals_tool_id` ON `approvals` (`tool_id`);--> statement-breakpoint
CREATE INDEX `approvals_status` ON `approvals` (`status`);
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"authority" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"output" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "workflows_authority" CHECK ("workflows"."authority" in ('read', 'write'))
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_kind";--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_name_unique" ON "workflows" USING btree ("name");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_kind" CHECK ("jobs"."kind" in ('build', 'heal', 'discover', 'workflow'));
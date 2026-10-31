CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"status" integer,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "users_role" CHECK ("users"."role" in ('viewer', 'editor', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "audit_events_created_at" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor" ON "audit_events" USING btree ("actor");--> statement-breakpoint
CREATE UNIQUE INDEX "users_name_unique" ON "users" USING btree ("name");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_id" ON "api_keys" USING btree ("user_id");
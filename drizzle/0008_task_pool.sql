CREATE TYPE "public"."pool_task_kind" AS ENUM('review', 'editorial');--> statement-breakpoint
CREATE TYPE "public"."pool_task_status" AS ENUM('open', 'claimed', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "pool_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" "pool_task_kind" NOT NULL,
	"version_no" integer NOT NULL,
	"status" "pool_task_status" DEFAULT 'open' NOT NULL,
	"claimed_by_agent_id" uuid,
	"claimed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "pool_tasks_open_unclaimed" CHECK ("pool_tasks"."status" <> 'open' OR "pool_tasks"."claimed_by_agent_id" IS NULL),
	CONSTRAINT "pool_tasks_claimed_holder" CHECK ("pool_tasks"."status" <> 'claimed' OR ("pool_tasks"."claimed_by_agent_id" IS NOT NULL AND "pool_tasks"."due_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "review_assignments" ADD COLUMN "pool_task_id" uuid;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "pool_tasks" ADD CONSTRAINT "pool_tasks_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_tasks" ADD CONSTRAINT "pool_tasks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_tasks" ADD CONSTRAINT "pool_tasks_claimed_by_agent_id_agents_id_fk" FOREIGN KEY ("claimed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_tasks_open_idx" ON "pool_tasks" USING btree ("journal_id","status","created_at");--> statement-breakpoint
CREATE INDEX "pool_tasks_due_idx" ON "pool_tasks" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "pool_tasks_submission_idx" ON "pool_tasks" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_tasks_one_per_agent_uq" ON "pool_tasks" USING btree ("claimed_by_agent_id") WHERE "pool_tasks"."status" = 'claimed';--> statement-breakpoint
CREATE UNIQUE INDEX "pool_tasks_one_editorial_uq" ON "pool_tasks" USING btree ("submission_id") WHERE "pool_tasks"."kind" = 'editorial' AND "pool_tasks"."status" IN ('open', 'claimed');--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_pool_task_id_pool_tasks_id_fk" FOREIGN KEY ("pool_task_id") REFERENCES "public"."pool_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Data: move existing (demo) work onto the pool. Assignments keep their history as claims.
UPDATE "review_assignments" SET "claimed_at" = coalesce("responded_at", "invited_at"), "release_reason" = "decline_reason";--> statement-breakpoint
-- Pending invitations and in-progress reviews are cancelled; their slots reopen in the pool below.
UPDATE "review_assignments" SET "status" = 'cancelled', "updated_at" = now() WHERE "status" IN ('invited', 'accepted');--> statement-breakpoint
-- Editors become reviewers: editorial work now depends on reputation, not on a granted role.
UPDATE "journal_memberships"
SET "roles" = ARRAY(SELECT DISTINCT r FROM unnest(array_append(array_remove("roles", 'editor'), 'reviewer')) AS r ORDER BY r)
WHERE 'editor' = ANY("roles");--> statement-breakpoint
-- No submission waits for an editor any more: it waits for an editorial task in the pool.
UPDATE "submissions" SET "status" = 'with_editor' WHERE "status" = 'submitted';--> statement-breakpoint
UPDATE "submissions" SET "handling_editor_id" = NULL;--> statement-breakpoint
-- Pool tasks are dated by the submission's last update, so older work is handed out first.
INSERT INTO "pool_tasks" ("journal_id", "submission_id", "kind", "version_no", "status", "created_at", "updated_at")
SELECT "journal_id", "id", 'editorial', "current_version_no", 'open', "updated_at", "updated_at"
FROM "submissions" WHERE "status" IN ('with_editor', 'awaiting_decision');--> statement-breakpoint
INSERT INTO "pool_tasks" ("journal_id", "submission_id", "kind", "version_no", "status", "created_at", "updated_at")
SELECT s."journal_id", s."id", 'review', s."current_version_no", 'open', s."updated_at", s."updated_at"
FROM "submissions" s
JOIN "journals" j ON j."id" = s."journal_id"
CROSS JOIN LATERAL generate_series(
  1,
  greatest(0, coalesce((j."policy"->>'reviewers_per_submission')::int, 2) - (
    SELECT count(*)::int FROM "review_assignments" ra
    WHERE ra."submission_id" = s."id" AND ra."version_no" = s."current_version_no" AND ra."status" = 'submitted'
  ))
) AS g
WHERE s."status" = 'under_review';

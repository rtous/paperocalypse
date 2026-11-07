-- Fresh start (journals and agent identities were removed). Drops everything an earlier version
-- of the schema created, so an existing database is reset; on a new database these do nothing.
DROP TABLE IF EXISTS "admins" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agents" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "api_keys" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "articles" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "article_citations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "attachments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "decisions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "flags" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "idempotency_keys" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "invite_codes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "journal_memberships" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "journals" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "operators" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "papercoin_transactions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pool_tasks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "rate_limit_buckets" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "review_assignments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "reviews" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "settings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "submission_authors" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "submission_versions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "submissions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tasks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "webhook_deliveries" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."actor_type" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."agent_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."assignment_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."attachment_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."decision_kind" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."flag_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."journal_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."member_role" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."membership_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."recommendation" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."reviewer_availability" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."submission_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."task_kind" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."task_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."webhook_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."papercoin_reason" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."operator_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."pool_task_kind" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."pool_task_status" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS events_append_only() CASCADE;--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('operator', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('accepted', 'declined', 'expired', 'submitted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'uploaded');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('desk_reject', 'reject', 'major_revision', 'minor_revision', 'accept');--> statement-breakpoint
CREATE TYPE "public"."flag_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."operator_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."papercoin_reason" AS ENUM('signup_grant', 'submission', 'publication', 'review', 'editorial_decision', 'admin_adjustment', 'wallet_transfer');--> statement-breakpoint
CREATE TYPE "public"."pool_task_kind" AS ENUM('review', 'editorial');--> statement-breakpoint
CREATE TYPE "public"."pool_task_status" AS ENUM('open', 'claimed', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('accept', 'minor_revision', 'major_revision', 'reject');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('with_editor', 'under_review', 'awaiting_decision', 'revision_requested', 'accepted', 'published', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "article_citations" (
	"citing_article_id" uuid NOT NULL,
	"cited_article_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_citations_citing_article_id_cited_article_id_pk" PRIMARY KEY("citing_article_id","cited_article_id"),
	CONSTRAINT "article_citations_not_self" CHECK ("article_citations"."citing_article_id" <> "article_citations"."cited_article_id")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"article_no" integer NOT NULL,
	"public_id" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"abstract" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"body_md" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authors" jsonb NOT NULL,
	"ai_disclosure" text NOT NULL,
	"content_sha256" text NOT NULL,
	"review_file" jsonb,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(abstract, '')), 'B') || setweight(to_tsvector('english', coalesce(body_md, '')), 'C')) STORED,
	CONSTRAINT "articles_submission_id_unique" UNIQUE("submission_id"),
	CONSTRAINT "articles_article_no_unique" UNIQUE("article_no"),
	CONSTRAINT "articles_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"max_size_bytes" integer NOT NULL,
	"pathname" text NOT NULL,
	"status" "attachment_status" DEFAULT 'pending' NOT NULL,
	"url" text,
	"size_bytes" integer,
	"sha256" text,
	"upload_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachments_pathname_unique" UNIQUE("pathname")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"editor_operator_id" uuid,
	"admin_user_id" uuid,
	"decision" "decision_kind" NOT NULL,
	"letter_md" text NOT NULL,
	CONSTRAINT "decision_actor" CHECK (("decisions"."editor_operator_id" IS NOT NULL) <> ("decisions"."admin_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"submission_id" uuid,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid,
	"raised_by_operator_id" uuid,
	"kind" text NOT NULL,
	"reason_md" text NOT NULL,
	"status" "flag_status" DEFAULT 'open' NOT NULL,
	"resolved_by_admin_id" uuid,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"github_login" text,
	"status" "operator_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"papercoins" integer DEFAULT 0 NOT NULL,
	"api_key_hash" text,
	"api_key_prefix" text,
	"api_key_created_at" timestamp with time zone,
	"api_key_last_used_at" timestamp with time zone,
	"reviewer_topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"webhook_failure_count" integer DEFAULT 0 NOT NULL,
	"webhook_disabled_at" timestamp with time zone,
	CONSTRAINT "operators_email_unique" UNIQUE("email"),
	CONSTRAINT "operators_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "papercoin_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"reason" "papercoin_reason" NOT NULL,
	"ref_id" uuid,
	"admin_id" uuid,
	"note" text,
	"balance_after" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" "pool_task_kind" NOT NULL,
	"version_no" integer NOT NULL,
	"status" "pool_task_status" DEFAULT 'open' NOT NULL,
	"claimed_by_operator_id" uuid,
	"claimed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "pool_tasks_open_unclaimed" CHECK ("pool_tasks"."status" <> 'open' OR "pool_tasks"."claimed_by_operator_id" IS NULL),
	CONSTRAINT "pool_tasks_claimed_holder" CHECK ("pool_tasks"."status" <> 'claimed' OR ("pool_tasks"."claimed_by_operator_id" IS NOT NULL AND "pool_tasks"."due_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "review_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"reviewer_operator_id" uuid NOT NULL,
	"pool_task_id" uuid,
	"claimed_at" timestamp with time zone NOT NULL,
	"release_reason" text,
	"status" "assignment_status" DEFAULT 'accepted' NOT NULL,
	"due_at" timestamp with time zone,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"recommendation" "recommendation" NOT NULL,
	"summary_md" text NOT NULL,
	"strengths_md" text DEFAULT '' NOT NULL,
	"weaknesses_md" text DEFAULT '' NOT NULL,
	"detailed_comments_md" text DEFAULT '' NOT NULL,
	"confidential_to_editor_md" text DEFAULT '' NOT NULL,
	"confidence" integer NOT NULL,
	"scores" jsonb NOT NULL,
	"integrity_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_score" integer NOT NULL,
	CONSTRAINT "reviews_assignment_id_unique" UNIQUE("assignment_id"),
	CONSTRAINT "reviews_overall_score_range" CHECK ("reviews"."overall_score" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"operator_id" uuid,
	"human_name" text,
	"human_affiliation" text,
	CONSTRAINT "submission_author_kind" CHECK (("submission_authors"."operator_id" IS NOT NULL) <> ("submission_authors"."human_name" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "submission_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submission_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"abstract" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"body_md" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_letter_md" text DEFAULT '' NOT NULL,
	"response_to_reviewers_md" text,
	"ai_disclosure" text NOT NULL,
	"content_sha256" text NOT NULL,
	"integrity_flags" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitting_operator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "submission_status" DEFAULT 'with_editor' NOT NULL,
	"handling_editor_id" uuid,
	"current_version_no" integer DEFAULT 1 NOT NULL,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"decision" "decision_kind",
	"published_article_id" uuid,
	"revision_due_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "article_citations" ADD CONSTRAINT "article_citations_citing_article_id_articles_id_fk" FOREIGN KEY ("citing_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_citations" ADD CONSTRAINT "article_citations_cited_article_id_articles_id_fk" FOREIGN KEY ("cited_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_editor_operator_id_operators_id_fk" FOREIGN KEY ("editor_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_admin_user_id_admins_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_raised_by_operator_id_operators_id_fk" FOREIGN KEY ("raised_by_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_resolved_by_admin_id_admins_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_tasks" ADD CONSTRAINT "pool_tasks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_tasks" ADD CONSTRAINT "pool_tasks_claimed_by_operator_id_operators_id_fk" FOREIGN KEY ("claimed_by_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_reviewer_operator_id_operators_id_fk" FOREIGN KEY ("reviewer_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_pool_task_id_pool_tasks_id_fk" FOREIGN KEY ("pool_task_id") REFERENCES "public"."pool_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assignment_id_review_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."review_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_versions" ADD CONSTRAINT "submission_versions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitting_operator_id_operators_id_fk" FOREIGN KEY ("submitting_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_handling_editor_id_operators_id_fk" FOREIGN KEY ("handling_editor_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_citations_cited_idx" ON "article_citations" USING btree ("cited_article_id");--> statement-breakpoint
CREATE INDEX "articles_search_idx" ON "articles" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "attachments_operator_idx" ON "attachments" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "decisions_submission_idx" ON "decisions" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "events_submission_idx" ON "events" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "events_action_idx" ON "events" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "flags_status_idx" ON "flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_uq" ON "idempotency_keys" USING btree ("operator_id","scope","key");--> statement-breakpoint
CREATE INDEX "papercoin_operator_idx" ON "papercoin_transactions" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "papercoin_once_per_ref_uq" ON "papercoin_transactions" USING btree ("reason","ref_id") WHERE "papercoin_transactions"."ref_id" IS NOT NULL AND "papercoin_transactions"."reason" IN ('signup_grant', 'submission', 'publication', 'review', 'editorial_decision');--> statement-breakpoint
CREATE INDEX "pool_tasks_open_idx" ON "pool_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pool_tasks_due_idx" ON "pool_tasks" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "pool_tasks_submission_idx" ON "pool_tasks" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_tasks_one_per_operator_uq" ON "pool_tasks" USING btree ("claimed_by_operator_id") WHERE "pool_tasks"."status" = 'claimed';--> statement-breakpoint
CREATE UNIQUE INDEX "pool_tasks_one_editorial_uq" ON "pool_tasks" USING btree ("submission_id") WHERE "pool_tasks"."kind" = 'editorial' AND "pool_tasks"."status" IN ('open', 'claimed');--> statement-breakpoint
CREATE INDEX "rate_limit_expires_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "assignments_submission_idx" ON "review_assignments" USING btree ("submission_id","version_no");--> statement-breakpoint
CREATE INDEX "assignments_reviewer_idx" ON "review_assignments" USING btree ("reviewer_operator_id","status");--> statement-breakpoint
CREATE INDEX "assignments_deadlines_idx" ON "review_assignments" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_authors_pos_uq" ON "submission_authors" USING btree ("submission_id","position");--> statement-breakpoint
CREATE INDEX "submission_authors_operator_idx" ON "submission_authors" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_versions_uq" ON "submission_versions" USING btree ("submission_id","version_no");--> statement-breakpoint
CREATE INDEX "submissions_status_idx" ON "submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "submissions_editor_idx" ON "submissions" USING btree ("handling_editor_id");--> statement-breakpoint
CREATE INDEX "submissions_operator_idx" ON "submissions" USING btree ("submitting_operator_id");--> statement-breakpoint
CREATE INDEX "webhook_pending_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");
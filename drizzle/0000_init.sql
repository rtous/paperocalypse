CREATE TYPE "public"."actor_type" AS ENUM('agent', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('invited', 'accepted', 'declined', 'expired', 'submitted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'uploaded');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('desk_reject', 'reject', 'major_revision', 'minor_revision', 'accept');--> statement-breakpoint
CREATE TYPE "public"."flag_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('draft', 'open', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('author', 'reviewer', 'editor');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('accept', 'minor_revision', 'major_revision', 'reject');--> statement-breakpoint
CREATE TYPE "public"."reviewer_availability" AS ENUM('available', 'paused');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('submitted', 'with_editor', 'under_review', 'awaiting_decision', 'revision_requested', 'accepted', 'published', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('screen_submission', 'invite_replacement_reviewer', 'make_decision', 'handle_revision', 'publish_article', 'respond_to_invitation', 'write_review', 'revise_submission');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done', 'expired');--> statement-breakpoint
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
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"operator_name" text,
	"operator_contact" text,
	"operator_contact_normalized" text,
	"webhook_url" text,
	"webhook_secret" text,
	"webhook_failure_count" integer DEFAULT 0 NOT NULL,
	"webhook_disabled_at" timestamp with time zone,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"volume" integer NOT NULL,
	"issue" integer,
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
	CONSTRAINT "articles_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
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
	"editor_agent_id" uuid,
	"admin_user_id" uuid,
	"decision" "decision_kind" NOT NULL,
	"letter_md" text NOT NULL,
	CONSTRAINT "decision_actor" CHECK (("decisions"."editor_agent_id" IS NOT NULL) <> ("decisions"."admin_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"journal_id" uuid,
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
	"journal_id" uuid NOT NULL,
	"submission_id" uuid,
	"raised_by_agent_id" uuid,
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
	"agent_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"roles_granted" "member_role"[] NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invite_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invite_roles_no_editor" CHECK (NOT ('editor' = ANY("invite_codes"."roles_granted")))
);
--> statement-breakpoint
CREATE TABLE "journal_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"roles" "member_role"[] DEFAULT '{}'::member_role[] NOT NULL,
	"reviewer_topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewer_availability" "reviewer_availability" DEFAULT 'available' NOT NULL,
	"max_concurrent_reviews" integer DEFAULT 3 NOT NULL,
	"status" "membership_status" DEFAULT 'pending' NOT NULL,
	"last_editor_assignment_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"scope_md" text DEFAULT '' NOT NULL,
	"author_guidelines_md" text DEFAULT '' NOT NULL,
	"reviewer_guidelines_md" text DEFAULT '' NOT NULL,
	"editor_guidelines_md" text DEFAULT '' NOT NULL,
	"agent_instructions_template_md" text,
	"status" "journal_status" DEFAULT 'draft' NOT NULL,
	"policy" jsonb NOT NULL,
	"last_article_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "journals_slug_unique" UNIQUE("slug")
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
	"reviewer_agent_id" uuid NOT NULL,
	"status" "assignment_status" DEFAULT 'invited' NOT NULL,
	"invited_at" timestamp with time zone NOT NULL,
	"respond_by" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"decline_reason" text,
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
	CONSTRAINT "reviews_assignment_id_unique" UNIQUE("assignment_id")
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
	"agent_id" uuid,
	"human_name" text,
	"human_affiliation" text,
	CONSTRAINT "submission_author_kind" CHECK (("submission_authors"."agent_id" IS NOT NULL) <> ("submission_authors"."human_name" IS NOT NULL))
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
	"journal_id" uuid NOT NULL,
	"submitting_agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "submission_status" DEFAULT 'submitted' NOT NULL,
	"handling_editor_id" uuid,
	"current_version_no" integer DEFAULT 1 NOT NULL,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"decision" "decision_kind",
	"published_article_id" uuid,
	"revision_due_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"submission_id" uuid,
	"kind" "task_kind" NOT NULL,
	"ref_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_editor_agent_id_agents_id_fk" FOREIGN KEY ("editor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_admin_user_id_admins_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_raised_by_agent_id_agents_id_fk" FOREIGN KEY ("raised_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_resolved_by_admin_id_admins_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_memberships" ADD CONSTRAINT "journal_memberships_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_memberships" ADD CONSTRAINT "journal_memberships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assignment_id_review_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."review_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_versions" ADD CONSTRAINT "submission_versions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitting_agent_id_agents_id_fk" FOREIGN KEY ("submitting_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_handling_editor_id_agents_id_fk" FOREIGN KEY ("handling_editor_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_operator_contact_idx" ON "agents" USING btree ("operator_contact_normalized");--> statement-breakpoint
CREATE INDEX "api_keys_agent_idx" ON "api_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_journal_no_uq" ON "articles" USING btree ("journal_id","article_no");--> statement-breakpoint
CREATE INDEX "articles_search_idx" ON "articles" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "attachments_agent_idx" ON "attachments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "decisions_submission_idx" ON "decisions" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "events_submission_idx" ON "events" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "events_journal_idx" ON "events" USING btree ("journal_id","created_at");--> statement-breakpoint
CREATE INDEX "events_action_idx" ON "events" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "flags_status_idx" ON "flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_uq" ON "idempotency_keys" USING btree ("agent_id","scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_journal_agent_uq" ON "journal_memberships" USING btree ("journal_id","agent_id");--> statement-breakpoint
CREATE INDEX "memberships_agent_idx" ON "journal_memberships" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "rate_limit_expires_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "assignments_submission_idx" ON "review_assignments" USING btree ("submission_id","version_no");--> statement-breakpoint
CREATE INDEX "assignments_reviewer_idx" ON "review_assignments" USING btree ("reviewer_agent_id","status");--> statement-breakpoint
CREATE INDEX "assignments_deadlines_idx" ON "review_assignments" USING btree ("status","respond_by","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_authors_pos_uq" ON "submission_authors" USING btree ("submission_id","position");--> statement-breakpoint
CREATE INDEX "submission_authors_agent_idx" ON "submission_authors" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_versions_uq" ON "submission_versions" USING btree ("submission_id","version_no");--> statement-breakpoint
CREATE INDEX "submissions_journal_status_idx" ON "submissions" USING btree ("journal_id","status");--> statement-breakpoint
CREATE INDEX "submissions_editor_idx" ON "submissions" USING btree ("handling_editor_id");--> statement-breakpoint
CREATE INDEX "submissions_agent_idx" ON "submissions" USING btree ("submitting_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_inbox_idx" ON "tasks" USING btree ("agent_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_open_uq" ON "tasks" USING btree ("agent_id","kind","ref_id") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "webhook_pending_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");
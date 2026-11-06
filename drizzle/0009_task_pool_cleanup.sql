ALTER TABLE "tasks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "tasks" CASCADE;--> statement-breakpoint
ALTER TABLE "invite_codes" DROP CONSTRAINT "invite_roles_no_editor";--> statement-breakpoint
ALTER TABLE "review_assignments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "review_assignments" ALTER COLUMN "status" SET DEFAULT 'accepted'::text;--> statement-breakpoint
DROP TYPE "public"."assignment_status";--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('accepted', 'declined', 'expired', 'submitted', 'cancelled');--> statement-breakpoint
ALTER TABLE "review_assignments" ALTER COLUMN "status" SET DEFAULT 'accepted'::"public"."assignment_status";--> statement-breakpoint
ALTER TABLE "review_assignments" ALTER COLUMN "status" SET DATA TYPE "public"."assignment_status" USING "status"::"public"."assignment_status";--> statement-breakpoint
ALTER TABLE "invite_codes" ALTER COLUMN "roles_granted" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "journal_memberships" ALTER COLUMN "roles" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "journal_memberships" ALTER COLUMN "roles" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "public"."member_role";--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('author', 'reviewer');--> statement-breakpoint
ALTER TABLE "invite_codes" ALTER COLUMN "roles_granted" SET DATA TYPE "public"."member_role"[] USING "roles_granted"::"public"."member_role"[];--> statement-breakpoint
ALTER TABLE "journal_memberships" ALTER COLUMN "roles" SET DATA TYPE "public"."member_role"[] USING "roles"::"public"."member_role"[];--> statement-breakpoint
ALTER TABLE "journal_memberships" ALTER COLUMN "roles" SET DEFAULT '{}'::"public"."member_role"[];--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "status" SET DEFAULT 'with_editor'::text;--> statement-breakpoint
DROP TYPE "public"."submission_status";--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('with_editor', 'under_review', 'awaiting_decision', 'revision_requested', 'accepted', 'published', 'rejected', 'withdrawn');--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "status" SET DEFAULT 'with_editor'::"public"."submission_status";--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "status" SET DATA TYPE "public"."submission_status" USING "status"::"public"."submission_status";--> statement-breakpoint
DROP INDEX "assignments_deadlines_idx";--> statement-breakpoint
ALTER TABLE "review_assignments" ALTER COLUMN "claimed_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "assignments_deadlines_idx" ON "review_assignments" USING btree ("status","due_at");--> statement-breakpoint
ALTER TABLE "journal_memberships" DROP COLUMN "reviewer_availability";--> statement-breakpoint
ALTER TABLE "journal_memberships" DROP COLUMN "max_concurrent_reviews";--> statement-breakpoint
ALTER TABLE "journal_memberships" DROP COLUMN "last_editor_assignment_at";--> statement-breakpoint
ALTER TABLE "review_assignments" DROP COLUMN "invited_at";--> statement-breakpoint
ALTER TABLE "review_assignments" DROP COLUMN "respond_by";--> statement-breakpoint
ALTER TABLE "review_assignments" DROP COLUMN "responded_at";--> statement-breakpoint
ALTER TABLE "review_assignments" DROP COLUMN "decline_reason";--> statement-breakpoint
DROP TYPE "public"."reviewer_availability";--> statement-breakpoint
DROP TYPE "public"."task_kind";--> statement-breakpoint
DROP TYPE "public"."task_status";
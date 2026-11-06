CREATE TYPE "public"."operator_status" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TYPE "public"."actor_type" ADD VALUE 'operator';--> statement-breakpoint
ALTER TYPE "public"."papercoin_reason" ADD VALUE 'editorial_decision' BEFORE 'admin_adjustment';--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"github_login" text,
	"status" "operator_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "operators_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "operator_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_operator_idx" ON "agents" USING btree ("operator_id");
CREATE TYPE "public"."papercoin_reason" AS ENUM('signup_grant', 'submission', 'publication', 'review', 'admin_adjustment');--> statement-breakpoint
CREATE TABLE "papercoin_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"reason" "papercoin_reason" NOT NULL,
	"ref_id" uuid,
	"journal_id" uuid,
	"admin_id" uuid,
	"note" text,
	"balance_after" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "papercoins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "papercoin_agent_idx" ON "papercoin_transactions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "papercoin_once_uq" ON "papercoin_transactions" USING btree ("agent_id","reason","ref_id") WHERE "papercoin_transactions"."ref_id" IS NOT NULL AND "papercoin_transactions"."reason" <> 'admin_adjustment';--> statement-breakpoint
-- Existing agents receive the default signup grant (3 papercoins).
INSERT INTO "papercoin_transactions" ("agent_id", "amount", "reason", "ref_id", "note", "balance_after")
SELECT "id", 3, 'signup_grant', "id", 'Initial grant when papercoins were introduced', "papercoins" + 3 FROM "agents";
--> statement-breakpoint
UPDATE "agents" SET "papercoins" = "papercoins" + 3;

ALTER TYPE "public"."papercoin_reason" ADD VALUE 'wallet_transfer';--> statement-breakpoint
DROP INDEX "papercoin_once_uq";--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "papercoins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD COLUMN "operator_id" uuid;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "papercoin_operator_idx" ON "papercoin_transactions" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "papercoin_once_per_ref_uq" ON "papercoin_transactions" USING btree ("reason","ref_id") WHERE "papercoin_transactions"."ref_id" IS NOT NULL AND "papercoin_transactions"."reason" IN ('signup_grant', 'submission', 'publication', 'review', 'editorial_decision');--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_has_wallet" CHECK ("papercoin_transactions"."operator_id" IS NOT NULL OR "papercoin_transactions"."agent_id" IS NOT NULL);--> statement-breakpoint
-- Papercoins now belong to operators: move linked agents' history and balances to their operator.
UPDATE "papercoin_transactions" pt SET "operator_id" = a."operator_id"
FROM "agents" a WHERE pt."agent_id" = a."id" AND a."operator_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "operators" o SET "papercoins" = coalesce((SELECT sum(a."papercoins") FROM "agents" a WHERE a."operator_id" = o."id"), 0);
--> statement-breakpoint
UPDATE "agents" SET "papercoins" = 0 WHERE "operator_id" IS NOT NULL;
--> statement-breakpoint
-- Operators without agents get the welcome grant (others already have their agents' grants).
INSERT INTO "papercoin_transactions" ("operator_id", "amount", "reason", "ref_id", "note", "balance_after")
SELECT o."id", 3, 'signup_grant', o."id", 'Welcome grant (papercoins now belong to operators)', o."papercoins" + 3
FROM "operators" o WHERE NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."operator_id" = o."id");
--> statement-breakpoint
UPDATE "operators" o SET "papercoins" = o."papercoins" + 3
WHERE NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."operator_id" = o."id");

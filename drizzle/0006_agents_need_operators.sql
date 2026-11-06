ALTER TABLE "papercoin_transactions" DROP CONSTRAINT "papercoin_has_wallet";--> statement-breakpoint
ALTER TABLE "papercoin_transactions" DROP CONSTRAINT "papercoin_transactions_agent_id_agents_id_fk";
--> statement-breakpoint
-- Every agent now belongs to an operator. Agents created before operator accounts existed
-- (simulation agents, admin-created editors) move to a platform operator that nobody can sign in as.
INSERT INTO "operators" ("email", "name") VALUES ('platform@paperocalypse.invalid', 'Paperocalypse platform')
ON CONFLICT ("email") DO NOTHING;
--> statement-breakpoint
UPDATE "papercoin_transactions" SET "operator_id" = (SELECT "id" FROM "operators" WHERE "email" = 'platform@paperocalypse.invalid')
WHERE "operator_id" IS NULL;
--> statement-breakpoint
UPDATE "operators" SET "papercoins" = "papercoins" + coalesce((SELECT sum("papercoins") FROM "agents" WHERE "operator_id" IS NULL), 0)
WHERE "email" = 'platform@paperocalypse.invalid';
--> statement-breakpoint
UPDATE "agents" SET
  "operator_id" = (SELECT "id" FROM "operators" WHERE "email" = 'platform@paperocalypse.invalid'),
  "operator_name" = 'Paperocalypse platform',
  "operator_contact" = 'platform@paperocalypse.invalid',
  "operator_contact_normalized" = 'platform@paperocalypse.invalid'
WHERE "operator_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "operator_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ALTER COLUMN "operator_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "papercoin_transactions" ADD CONSTRAINT "papercoin_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "papercoins";

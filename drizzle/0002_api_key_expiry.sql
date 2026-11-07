ALTER TABLE "operators" ADD COLUMN "api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "api_key_expires_at" timestamp with time zone;
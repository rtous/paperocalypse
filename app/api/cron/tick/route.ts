import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { runTick } from "@/lib/domain/tick";
import { guardedWebhookFetch } from "@/lib/webhook-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Constant-time check of "Authorization: Bearer <CRON_SECRET>". */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Called by Vercel Cron (GET) and by the GitHub Actions scheduler. */
export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await runTick(getDb(), guardedWebhookFetch, new Date());
  return Response.json(result);
}

export const POST = GET;

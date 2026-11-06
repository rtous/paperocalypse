import { and, asc, eq } from "drizzle-orm";
import { events } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { actorId, type Actor } from "./actor";

/** Append a row to the audit log. Events are never updated or deleted (enforced by a trigger). */
export async function recordEvent(
  tx: Db,
  actor: Actor,
  action: string,
  opts: {
    journalId?: string | null;
    submissionId?: string | null;
    payload?: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(events).values({
    actorType: actor.type,
    actorId: actorId(actor),
    journalId: opts.journalId ?? null,
    submissionId: opts.submissionId ?? null,
    action,
    payload: opts.payload ?? {},
    ipHash: actor.type === "system" ? null : (actor.ipHash ?? null),
    createdAt: opts.now,
    updatedAt: opts.now,
  });
}

export async function listSubmissionEvents(db: Db, submissionId: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.submissionId, submissionId)))
    .orderBy(asc(events.createdAt), asc(events.id));
}

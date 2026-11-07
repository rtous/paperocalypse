import { and, eq, gte, inArray, isNotNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { submissionAuthors, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { findConflicts, type CoiFacts, type ConflictReason } from "./coi";

/** Load the facts needed to check conflicts of interest for one submission. */
export async function loadCoiFacts(
  db: Db,
  submissionId: string,
  opts: { coauthorMonths: number; now: Date },
): Promise<CoiFacts> {
  const authorRows = await db
    .select({ operatorId: submissionAuthors.operatorId })
    .from(submissionAuthors)
    .where(and(eq(submissionAuthors.submissionId, submissionId), isNotNull(submissionAuthors.operatorId)));
  const authorIds = authorRows.map((a) => a.operatorId!);

  const recent = new Set<string>();
  if (authorIds.length > 0 && opts.coauthorMonths > 0) {
    const cutoff = new Date(opts.now);
    cutoff.setMonth(cutoff.getMonth() - opts.coauthorMonths);
    const sa1 = alias(submissionAuthors, "sa1");
    const sa2 = alias(submissionAuthors, "sa2");
    const rows = await db
      .selectDistinct({ operatorId: sa2.operatorId })
      .from(sa1)
      .innerJoin(sa2, eq(sa2.submissionId, sa1.submissionId))
      .innerJoin(submissions, eq(submissions.id, sa1.submissionId))
      .where(
        and(
          ne(submissions.id, submissionId),
          gte(submissions.createdAt, cutoff),
          inArray(sa1.operatorId, authorIds),
          isNotNull(sa2.operatorId),
        ),
      );
    for (const r of rows) if (r.operatorId) recent.add(r.operatorId);
  }

  return { authorIds: new Set(authorIds), recentCoauthorIds: recent };
}

/** The operator's conflicts on a submission (empty = none). */
export async function conflictsOf(db: Db, submissionId: string, operatorId: string, opts: { coauthorMonths: number; now: Date }): Promise<ConflictReason[]> {
  return findConflicts(operatorId, await loadCoiFacts(db, submissionId, opts));
}

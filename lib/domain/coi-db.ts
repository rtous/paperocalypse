import { and, eq, gte, inArray, isNotNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agents, submissionAuthors, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { CONFLICT_MESSAGES, findConflicts, type CoiFacts, type ConflictReason } from "./coi";
import { DomainError } from "./errors";

/** Load the facts needed to check conflicts of interest for one submission. */
export async function loadCoiFacts(
  db: Db,
  submissionId: string,
  opts: { coauthorMonths: number; now: Date },
): Promise<CoiFacts> {
  const [sub] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  if (!sub) throw new Error(`Submission ${submissionId} not found`);

  const authorRows = await db
    .select({ agentId: agents.id, operatorContact: agents.operatorContactNormalized })
    .from(submissionAuthors)
    .innerJoin(agents, eq(agents.id, submissionAuthors.agentId))
    .where(eq(submissionAuthors.submissionId, submissionId));
  const authorIds = authorRows.map((a) => a.agentId);

  const recent = new Set<string>();
  if (authorIds.length > 0 && opts.coauthorMonths > 0) {
    const cutoff = new Date(opts.now);
    cutoff.setMonth(cutoff.getMonth() - opts.coauthorMonths);
    const sa1 = alias(submissionAuthors, "sa1");
    const sa2 = alias(submissionAuthors, "sa2");
    const rows = await db
      .selectDistinct({ agentId: sa2.agentId })
      .from(sa1)
      .innerJoin(sa2, eq(sa2.submissionId, sa1.submissionId))
      .innerJoin(submissions, eq(submissions.id, sa1.submissionId))
      .where(
        and(
          ne(submissions.id, submissionId),
          gte(submissions.createdAt, cutoff),
          inArray(sa1.agentId, authorIds),
          isNotNull(sa2.agentId),
        ),
      );
    for (const r of rows) if (r.agentId) recent.add(r.agentId);
  }

  return { authors: authorRows, recentCoauthorIds: recent };
}

/** Conflicts for each candidate (empty array = no conflict). */
export async function conflictsFor(
  db: Db,
  facts: CoiFacts,
  candidateIds: string[],
): Promise<Map<string, ConflictReason[]>> {
  const out = new Map<string, ConflictReason[]>();
  if (candidateIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agents.id, operatorContact: agents.operatorContactNormalized })
    .from(agents)
    .where(inArray(agents.id, candidateIds));
  for (const r of rows) out.set(r.agentId, findConflicts(r, facts));
  return out;
}

export function assertNoConflict(agentId: string, reasons: ConflictReason[] | undefined, role: string) {
  if (reasons && reasons.length > 0) {
    throw new DomainError(
      "CONFLICT_OF_INTEREST",
      `Agent ${agentId} cannot act as ${role} on this submission: it ${reasons
        .map((r) => CONFLICT_MESSAGES[r])
        .join(" and ")}. Choose someone else.`,
      { agent_id: agentId, reasons },
    );
  }
}

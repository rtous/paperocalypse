import { and, desc, eq, sql } from "drizzle-orm";
import { agents, papercoinTransactions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";

/**
 * Papercoins: the platform's credit for peer review.
 *   - submitting a manuscript costs 1 (refused if the balance is too low);
 *   - publishing an article costs 2, charged to the submitting agent (may go negative, so an
 *     editor is never blocked; the debt blocks the author's next submission);
 *   - each completed review earns 1;
 *   - new agents start with a signup grant (platform setting, default 3).
 * Balances live on agents.papercoins; every change is a row in papercoin_transactions.
 */
export const PAPERCOIN_COST = { submission: 1, publication: 2 } as const;
export const PAPERCOIN_REWARD = { review: 1 } as const;

export type PapercoinReason = (typeof papercoinTransactions.$inferSelect)["reason"];

/**
 * Apply one ledger entry atomically: lock the agent, check the balance, append the entry and
 * update the cached balance. Entries with a refId are applied at most once (idempotent).
 * Returns the balance after the entry.
 */
export async function applyPapercoins(
  tx: Db,
  entry: {
    agentId: string;
    amount: number;
    reason: PapercoinReason;
    refId?: string | null;
    journalId?: string | null;
    adminId?: string | null;
    note?: string | null;
    allowNegative?: boolean;
    now: Date;
  },
): Promise<number> {
  const [agent] = await tx
    .select({ balance: agents.papercoins })
    .from(agents)
    .where(eq(agents.id, entry.agentId))
    .for("update");
  if (!agent) throw notFound("Agent");

  if (entry.refId && entry.reason !== "admin_adjustment") {
    const [done] = await tx
      .select({ id: papercoinTransactions.id })
      .from(papercoinTransactions)
      .where(
        and(
          eq(papercoinTransactions.agentId, entry.agentId),
          eq(papercoinTransactions.reason, entry.reason),
          eq(papercoinTransactions.refId, entry.refId),
        ),
      );
    if (done) return agent.balance;
  }

  const after = agent.balance + entry.amount;
  if (entry.amount < 0 && !entry.allowNegative && after < 0) {
    throw new DomainError(
      "INSUFFICIENT_PAPERCOINS",
      `This needs ${-entry.amount} papercoin(s) and your balance is ${agent.balance}. Earn papercoins by reviewing: each completed review earns ${PAPERCOIN_REWARD.review}. Join as a reviewer (join_journal with roles ["reviewer"]) and accept invitations from get_my_tasks.`,
      { balance: agent.balance, required: -entry.amount },
    );
  }
  await tx.insert(papercoinTransactions).values({
    agentId: entry.agentId,
    amount: entry.amount,
    reason: entry.reason,
    refId: entry.refId ?? null,
    journalId: entry.journalId ?? null,
    adminId: entry.adminId ?? null,
    note: entry.note ?? null,
    balanceAfter: after,
    createdAt: entry.now,
    updatedAt: entry.now,
  });
  await tx
    .update(agents)
    .set({ papercoins: sql`${agents.papercoins} + ${entry.amount}` })
    .where(eq(agents.id, entry.agentId));
  return after;
}

export async function getPapercoinBalance(db: Db, agentId: string): Promise<number> {
  const [a] = await db.select({ balance: agents.papercoins }).from(agents).where(eq(agents.id, agentId));
  if (!a) throw notFound("Agent");
  return a.balance;
}

export async function listPapercoinTransactions(db: Db, agentId: string, limit: number, offset: number) {
  return db
    .select({
      amount: papercoinTransactions.amount,
      reason: papercoinTransactions.reason,
      ref_id: papercoinTransactions.refId,
      note: papercoinTransactions.note,
      balance_after: papercoinTransactions.balanceAfter,
      at: papercoinTransactions.createdAt,
    })
    .from(papercoinTransactions)
    .where(eq(papercoinTransactions.agentId, agentId))
    .orderBy(desc(papercoinTransactions.createdAt), desc(papercoinTransactions.id))
    .limit(limit)
    .offset(offset);
}

/** Admin grant (positive) or deduction (negative), with a mandatory note. */
export async function adjustPapercoins(db: Db, actor: Actor, agentId: string, amount: number, note: string, now: Date) {
  if (actor.type !== "admin") throw notAuthorized("Only admins adjust papercoins.");
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000) {
    throw validationError("The amount must be a non-zero whole number between -1000 and 1000.");
  }
  if (note.trim().length < 3) throw validationError("Add a note explaining the adjustment.");
  return db.transaction(async (tx) => {
    const balance = await applyPapercoins(tx, {
      agentId,
      amount,
      reason: "admin_adjustment",
      adminId: actor.adminId,
      note: note.trim(),
      allowNegative: true,
      now,
    });
    await recordEvent(tx, actor, "papercoins.adjusted", { payload: { agent_id: agentId, amount, note: note.trim(), balance }, now });
    return balance;
  });
}

/** Human-readable summary of the rules, for tool responses and instructions. */
export function papercoinRules(signupGrant: number) {
  return {
    submission_cost: PAPERCOIN_COST.submission,
    publication_cost: PAPERCOIN_COST.publication,
    review_reward: PAPERCOIN_REWARD.review,
    signup_grant: signupGrant,
    summary: `Submitting costs ${PAPERCOIN_COST.submission}, publishing costs ${PAPERCOIN_COST.publication} (charged to the submitting author when the article is published; the balance may go negative), and each completed review earns ${PAPERCOIN_REWARD.review}. New agents start with ${signupGrant}.`,
  };
}

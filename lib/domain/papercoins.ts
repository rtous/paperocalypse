import { desc, eq, and, sql } from "drizzle-orm";
import { operators, papercoinTransactions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { getPlatformSettings } from "./settings";

/**
 * Papercoins: the platform's credit for peer review.
 *   - submitting a manuscript costs 1 (refused if the balance is too low);
 *   - publishing an article costs 2, charged when it is published (may go negative, so an editor
 *     is never blocked; the debt blocks the next submission);
 *   - each completed review and each editorial decision earns 1.
 *
 * Papercoins belong to operators (operators.papercoins). The welcome grant is given once per
 * operator. Every change is a row in papercoin_transactions.
 */
export const PAPERCOIN_COST = { submission: 1, publication: 2 } as const;
/** Each completed pool task pays 1: a review, or an editorial task (screening, a decision). */
export const PAPERCOIN_REWARD = { review: 1, editorial_task: 1 } as const;

export type PapercoinReason = (typeof papercoinTransactions.$inferSelect)["reason"];

/**
 * Apply one ledger entry atomically: lock the operator's wallet, check the balance, append the
 * entry, update the cached balance. Entries with a refId are applied at most once.
 * Returns the wallet balance after the entry.
 */
export async function applyPapercoins(
  tx: Db,
  entry: {
    operatorId: string;
    amount: number;
    reason: PapercoinReason;
    refId?: string | null;
    adminId?: string | null;
    note?: string | null;
    allowNegative?: boolean;
    now: Date;
  },
): Promise<number> {
  const operatorId = entry.operatorId;
  const [wallet] = await tx
    .select({ balance: operators.papercoins })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .for("update");
  if (!wallet) throw notFound("Operator");

  if (entry.refId && entry.reason !== "admin_adjustment") {
    const [done] = await tx
      .select({ id: papercoinTransactions.id })
      .from(papercoinTransactions)
      .where(and(eq(papercoinTransactions.reason, entry.reason), eq(papercoinTransactions.refId, entry.refId)));
    if (done) return wallet.balance;
  }

  const after = wallet.balance + entry.amount;
  if (entry.amount < 0 && !entry.allowNegative && after < 0) {
    throw new DomainError(
      "INSUFFICIENT_PAPERCOINS",
      `This needs ${-entry.amount} papercoin(s) and your balance is ${wallet.balance}. Earn papercoins by reviewing: each completed review earns ${PAPERCOIN_REWARD.review}. Call request_task to get a review from the pool.`,
      { balance: wallet.balance, required: -entry.amount },
    );
  }
  await tx.insert(papercoinTransactions).values({
    operatorId,
    amount: entry.amount,
    reason: entry.reason,
    refId: entry.refId ?? null,
    adminId: entry.adminId ?? null,
    note: entry.note ?? null,
    balanceAfter: after,
    createdAt: entry.now,
    updatedAt: entry.now,
  });
  await tx
    .update(operators)
    .set({ papercoins: sql`${operators.papercoins} + ${entry.amount}` })
    .where(eq(operators.id, operatorId));
  return after;
}

export async function getPapercoinBalance(db: Db, operatorId: string): Promise<number> {
  const [row] = await db.select({ balance: operators.papercoins }).from(operators).where(eq(operators.id, operatorId));
  if (!row) throw notFound("Operator");
  return row.balance;
}

/** The wallet's transactions, newest first. */
export async function listPapercoinTransactions(db: Db, operatorId: string, limit: number, offset: number) {
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
    .where(eq(papercoinTransactions.operatorId, operatorId))
    .orderBy(desc(papercoinTransactions.createdAt), desc(papercoinTransactions.id))
    .limit(limit)
    .offset(offset);
}

/** Give a new operator the welcome grant (once; safe to call on every sign-in). */
export async function grantOperatorWelcome(tx: Db, operatorId: string, now: Date) {
  const { papercoin_signup_grant: grant } = await getPlatformSettings(tx);
  if (grant <= 0) return;
  await applyPapercoins(tx, { operatorId, amount: grant, reason: "signup_grant", refId: operatorId, note: "Welcome grant", now });
}

/** Admin grant (positive) or deduction (negative) on an operator's wallet. */
export async function adjustPapercoins(db: Db, actor: Actor, operatorId: string, amount: number, note: string, now: Date) {
  if (actor.type !== "admin") throw notAuthorized("Only admins adjust papercoins.");
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000) {
    throw validationError("The amount must be a non-zero whole number between -1000 and 1000.");
  }
  if (note.trim().length < 3) throw validationError("Add a note explaining the adjustment.");
  return db.transaction(async (tx) => {
    const balance = await applyPapercoins(tx, {
      operatorId,
      amount,
      reason: "admin_adjustment",
      adminId: actor.adminId,
      note: note.trim(),
      allowNegative: true,
      now,
    });
    await recordEvent(tx, actor, "papercoins.adjusted", { payload: { operator_id: operatorId, amount, note: note.trim(), balance }, now });
    return balance;
  });
}

/** Human-readable summary of the rules, for tool responses and instructions. */
export function papercoinRules(signupGrant: number) {
  return {
    submission_cost: PAPERCOIN_COST.submission,
    publication_cost: PAPERCOIN_COST.publication,
    review_reward: PAPERCOIN_REWARD.review,
    editorial_task_reward: PAPERCOIN_REWARD.editorial_task,
    signup_grant: signupGrant,
    summary: `Papercoins belong to your operator account (every agent using your API key spends from the same wallet). Submitting costs ${PAPERCOIN_COST.submission}, publishing costs ${PAPERCOIN_COST.publication} (charged when the article is published; the balance may go negative), each completed review earns ${PAPERCOIN_REWARD.review}, and each completed editorial task (screening or a decision) earns ${PAPERCOIN_REWARD.editorial_task}. Get tasks with request_task. New operators start with ${signupGrant}.`,
  };
}

import { desc, eq, and, sql } from "drizzle-orm";
import { agents, operators, papercoinTransactions } from "@/lib/db/schema";
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
 * Papercoins belong to operators: every agent belongs to one, and all agents of an operator share
 * one wallet (operators.papercoins). The welcome grant is given once per operator. Every change is
 * a row in papercoin_transactions (operator_id = wallet, agent_id = the agent that acted, if any).
 */
export const PAPERCOIN_COST = { submission: 1, publication: 2 } as const;
/** Each completed pool task pays 1: a review, or an editorial task (screening, a decision). */
export const PAPERCOIN_REWARD = { review: 1, editorial_task: 1 } as const;

export type PapercoinReason = (typeof papercoinTransactions.$inferSelect)["reason"];

/** The operator whose wallet an agent spends from. */
export async function operatorOfAgent(db: Db, agentId: string): Promise<string> {
  const [a] = await db.select({ operatorId: agents.operatorId }).from(agents).where(eq(agents.id, agentId));
  if (!a) throw notFound("Agent");
  return a.operatorId;
}

/**
 * Apply one ledger entry atomically: lock the operator's wallet, check the balance, append the
 * entry, update the cached balance. Entries with a refId are applied at most once.
 * Pass `operatorId` for operator-level entries, or `agentId` to use that agent's operator.
 * Returns the wallet balance after the entry.
 */
export async function applyPapercoins(
  tx: Db,
  entry: {
    agentId?: string | null;
    operatorId?: string | null;
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
  if (!entry.operatorId && !entry.agentId) throw new Error("applyPapercoins needs agentId or operatorId");
  const operatorId = entry.operatorId ?? (await operatorOfAgent(tx, entry.agentId!));
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
      `This needs ${-entry.amount} papercoin(s) and your operator's balance is ${wallet.balance}. Earn papercoins by reviewing: each completed review earns ${PAPERCOIN_REWARD.review}. Join as a reviewer (join_journal with roles ["reviewer"]) and accept invitations from get_my_tasks.`,
      { balance: wallet.balance, required: -entry.amount },
    );
  }
  await tx.insert(papercoinTransactions).values({
    operatorId,
    agentId: entry.agentId ?? null,
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
    .update(operators)
    .set({ papercoins: sql`${operators.papercoins} + ${entry.amount}` })
    .where(eq(operators.id, operatorId));
  return after;
}

/** The balance an agent can spend: its operator's wallet. */
export async function getPapercoinBalance(db: Db, agentId: string): Promise<number> {
  return (await walletInfo(db, agentId)).balance;
}

export async function walletInfo(db: Db, agentId: string) {
  const [row] = await db
    .select({ balance: operators.papercoins, operatorName: operators.name })
    .from(agents)
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .where(eq(agents.id, agentId));
  if (!row) throw notFound("Agent");
  return row;
}

/** The wallet's transactions (all agents of the operator), newest first. */
export async function listPapercoinTransactions(db: Db, agentId: string, limit: number, offset: number) {
  const operatorId = await operatorOfAgent(db, agentId);
  return db
    .select({
      amount: papercoinTransactions.amount,
      reason: papercoinTransactions.reason,
      ref_id: papercoinTransactions.refId,
      note: papercoinTransactions.note,
      balance_after: papercoinTransactions.balanceAfter,
      agent: agents.displayName,
      at: papercoinTransactions.createdAt,
    })
    .from(papercoinTransactions)
    .leftJoin(agents, eq(agents.id, papercoinTransactions.agentId))
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
    summary: `Papercoins belong to your human operator and are shared by all of their agents. Submitting costs ${PAPERCOIN_COST.submission}, publishing costs ${PAPERCOIN_COST.publication} (charged when the article is published; the balance may go negative), each completed review earns ${PAPERCOIN_REWARD.review}, and each completed editorial task (screening or a decision) earns ${PAPERCOIN_REWARD.editorial_task}. Get tasks with request_task. New operators start with ${signupGrant}.`,
  };
}

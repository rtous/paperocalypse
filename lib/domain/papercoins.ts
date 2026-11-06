import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
 * Wallets belong to operators: all agents of one human share a single balance, and the welcome
 * grant is given once per operator. Agents without an operator (legacy or platform agents) have
 * their own wallet. Every change is a row in papercoin_transactions:
 *   operator wallet → operator_id set (agent_id = the agent that acted, if any)
 *   agent wallet    → operator_id null, agent_id set
 */
export const PAPERCOIN_COST = { submission: 1, publication: 2 } as const;
export const PAPERCOIN_REWARD = { review: 1, editorial_decision: 1 } as const;

export type PapercoinReason = (typeof papercoinTransactions.$inferSelect)["reason"];
export type Wallet = { kind: "operator"; id: string } | { kind: "agent"; id: string };

export async function walletOfAgent(db: Db, agentId: string): Promise<Wallet> {
  const [a] = await db.select({ operatorId: agents.operatorId }).from(agents).where(eq(agents.id, agentId));
  if (!a) throw notFound("Agent");
  return a.operatorId ? { kind: "operator", id: a.operatorId } : { kind: "agent", id: agentId };
}

async function lockBalance(tx: Db, w: Wallet): Promise<number> {
  if (w.kind === "operator") {
    const [o] = await tx.select({ b: operators.papercoins }).from(operators).where(eq(operators.id, w.id)).for("update");
    if (!o) throw notFound("Operator");
    return o.b;
  }
  const [a] = await tx.select({ b: agents.papercoins }).from(agents).where(eq(agents.id, w.id)).for("update");
  if (!a) throw notFound("Agent");
  return a.b;
}

async function addToBalance(tx: Db, w: Wallet, amount: number) {
  if (w.kind === "operator") {
    await tx.update(operators).set({ papercoins: sql`${operators.papercoins} + ${amount}` }).where(eq(operators.id, w.id));
  } else {
    await tx.update(agents).set({ papercoins: sql`${agents.papercoins} + ${amount}` }).where(eq(agents.id, w.id));
  }
}

/**
 * Apply one ledger entry atomically: resolve and lock the wallet, check the balance, append the
 * entry, update the cached balance. Entries with a refId are applied at most once.
 * The wallet is the operator's when `operatorId` is given or the acting agent has one.
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
  const wallet: Wallet = entry.operatorId ? { kind: "operator", id: entry.operatorId } : await walletOfAgent(tx, entry.agentId!);
  const balance = await lockBalance(tx, wallet);

  if (entry.refId && entry.reason !== "admin_adjustment" && entry.reason !== "wallet_transfer") {
    const [done] = await tx
      .select({ id: papercoinTransactions.id })
      .from(papercoinTransactions)
      .where(and(eq(papercoinTransactions.reason, entry.reason), eq(papercoinTransactions.refId, entry.refId)));
    if (done) return balance;
  }

  const after = balance + entry.amount;
  if (entry.amount < 0 && !entry.allowNegative && after < 0) {
    throw new DomainError(
      "INSUFFICIENT_PAPERCOINS",
      `This needs ${-entry.amount} papercoin(s) and your${wallet.kind === "operator" ? " operator's" : ""} balance is ${balance}. Earn papercoins by reviewing: each completed review earns ${PAPERCOIN_REWARD.review}. Join as a reviewer (join_journal with roles ["reviewer"]) and accept invitations from get_my_tasks.`,
      { balance, required: -entry.amount },
    );
  }
  await tx.insert(papercoinTransactions).values({
    operatorId: wallet.kind === "operator" ? wallet.id : null,
    agentId: entry.agentId ?? (wallet.kind === "agent" ? wallet.id : null),
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
  await addToBalance(tx, wallet, entry.amount);
  return after;
}

/** The balance an agent can spend: its operator's wallet, or its own if it has no operator. */
export async function getPapercoinBalance(db: Db, agentId: string): Promise<number> {
  return (await walletInfo(db, agentId)).balance;
}

export async function walletInfo(db: Db, agentId: string) {
  const [row] = await db
    .select({ agentBalance: agents.papercoins, operatorId: agents.operatorId, operatorBalance: operators.papercoins, operatorName: operators.name })
    .from(agents)
    .leftJoin(operators, eq(operators.id, agents.operatorId))
    .where(eq(agents.id, agentId));
  if (!row) throw notFound("Agent");
  return row.operatorId
    ? { owner: "operator" as const, balance: row.operatorBalance ?? 0, operatorName: row.operatorName }
    : { owner: "agent" as const, balance: row.agentBalance, operatorName: null };
}

/** The wallet's transactions (all agents of the operator), newest first. */
export async function listPapercoinTransactions(db: Db, agentId: string, limit: number, offset: number) {
  const w = await walletOfAgent(db, agentId);
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
    .where(
      w.kind === "operator"
        ? eq(papercoinTransactions.operatorId, w.id)
        : and(eq(papercoinTransactions.agentId, w.id), isNull(papercoinTransactions.operatorId)),
    )
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

/** Move an agent's own balance into its (new) operator's wallet. */
export async function mergeAgentWalletIntoOperator(tx: Db, agentId: string, operatorId: string, now: Date) {
  const [a] = await tx.select({ b: agents.papercoins }).from(agents).where(eq(agents.id, agentId)).for("update");
  if (!a || a.b === 0) return;
  const note = "Agent balance moved to its operator's wallet";
  await tx.insert(papercoinTransactions).values({
    agentId,
    amount: -a.b,
    reason: "wallet_transfer",
    note,
    balanceAfter: 0,
    createdAt: now,
    updatedAt: now,
  });
  await tx.update(agents).set({ papercoins: 0 }).where(eq(agents.id, agentId));
  await applyPapercoins(tx, { operatorId, agentId, amount: a.b, reason: "wallet_transfer", note, allowNegative: true, now });
}

/** Admin grant (positive) or deduction (negative) on the wallet the agent spends from. */
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
    editorial_decision_reward: PAPERCOIN_REWARD.editorial_decision,
    signup_grant: signupGrant,
    summary: `Papercoins belong to your human operator and are shared by all of their agents. Submitting costs ${PAPERCOIN_COST.submission}, publishing costs ${PAPERCOIN_COST.publication} (charged when the article is published; the balance may go negative), each completed review earns ${PAPERCOIN_REWARD.review}, and each editorial decision (desk reject, accept, reject or revision request) earns ${PAPERCOIN_REWARD.editorial_decision}. New operators start with ${signupGrant}.`,
  };
}

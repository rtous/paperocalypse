import { createHmac, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, inviteCodes, journalMemberships, journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import type { Role } from "./agents";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { parsePolicy } from "./policy";

function requireAdmin(actor: Actor): void {
  if (actor.type !== "admin") throw notAuthorized("Only admins manage memberships.");
}

export async function setMembershipStatus(
  db: Db,
  actor: Actor,
  membershipId: string,
  status: "active" | "suspended",
  now: Date,
) {
  requireAdmin(actor);
  await db.transaction(async (tx) => {
    const [m] = await tx
      .update(journalMemberships)
      .set({ status, updatedAt: now })
      .where(eq(journalMemberships.id, membershipId))
      .returning();
    if (!m) throw notFound("Membership");
    await recordEvent(tx, actor, `membership.${status === "active" ? "approved" : "suspended"}`, {
      journalId: m.journalId,
      payload: { agent_id: m.agentId, membership_id: m.id },
      now,
    });
  });
}

export async function removeRole(db: Db, actor: Actor, membershipId: string, role: Role, now: Date) {
  requireAdmin(actor);
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(journalMemberships).where(eq(journalMemberships.id, membershipId)).for("update");
    if (!m) throw notFound("Membership");
    await tx
      .update(journalMemberships)
      .set({ roles: m.roles.filter((r) => r !== role), updatedAt: now })
      .where(eq(journalMemberships.id, membershipId));
    await recordEvent(tx, actor, "membership.role_removed", {
      journalId: m.journalId,
      payload: { agent_id: m.agentId, role },
      now,
    });
  });
}

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

function hashCode(code: string): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) throw new Error("API_KEY_PEPPER must be set");
  return createHmac("sha256", pepper).update(`invite:${code.trim()}`).digest("hex");
}

/** Create an invite code. The plain code is returned once; only its hash is stored. */
export async function createInviteCode(
  db: Db,
  actor: Actor,
  journalId: string,
  opts: { roles: Role[]; maxUses: number; expiresAt: Date | null; label: string },
  now: Date,
) {
  requireAdmin(actor);
  const roles = [...new Set(opts.roles)];
  if (roles.length === 0) throw validationError("Choose at least one role.");
  if (!Number.isInteger(opts.maxUses) || opts.maxUses < 1 || opts.maxUses > 10_000) {
    throw validationError("max uses must be between 1 and 10,000.");
  }
  const code = `inv_${randomBytes(12).toString("base64url")}`;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(inviteCodes)
      .values({
        journalId,
        codeHash: hashCode(code),
        label: opts.label,
        rolesGranted: roles,
        maxUses: opts.maxUses,
        expiresAt: opts.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: inviteCodes.id });
    await recordEvent(tx, actor, "invite_code.created", {
      journalId,
      payload: { invite_code_id: row!.id, roles, max_uses: opts.maxUses },
      now,
    });
    return { code, id: row!.id };
  });
}

export async function revokeInviteCode(db: Db, actor: Actor, inviteCodeId: string, now: Date) {
  requireAdmin(actor);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(inviteCodes)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(inviteCodes.id, inviteCodeId))
      .returning({ journalId: inviteCodes.journalId });
    if (!row) throw notFound("Invite code");
    await recordEvent(tx, actor, "invite_code.revoked", {
      journalId: row.journalId,
      payload: { invite_code_id: inviteCodeId },
      now,
    });
  });
}

/**
 * Atomically consume one use of an invite code for a journal. Returns the roles it grants.
 * Throws VALIDATION_ERROR for unknown, revoked, expired or used-up codes.
 */
export async function consumeInviteCode(tx: Db, journalId: string, code: string, now: Date): Promise<Role[]> {
  const [row] = await tx
    .update(inviteCodes)
    .set({ uses: sql`${inviteCodes.uses} + 1`, updatedAt: now })
    .where(
      and(
        eq(inviteCodes.journalId, journalId),
        eq(inviteCodes.codeHash, hashCode(code)),
        sql`${inviteCodes.revokedAt} IS NULL`,
        sql`(${inviteCodes.expiresAt} IS NULL OR ${inviteCodes.expiresAt} > ${now})`,
        sql`${inviteCodes.uses} < ${inviteCodes.maxUses}`,
      ),
    )
    .returning({ roles: inviteCodes.rolesGranted });
  if (!row) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "That invite code is not valid for this journal (unknown, expired, revoked or used up). Ask the journal admins for a new one.",
    );
  }
  return row.roles;
}

// ---------------------------------------------------------------------------
// Self-service: join a journal, reviewer profile
// ---------------------------------------------------------------------------

/**
 * Join a journal (or add roles). Outcome depends on registration_mode:
 * open → active; invite_code → active if the code grants the roles; admin_approval → pending.
 */
export async function joinJournal(
  db: Db,
  actor: Actor & { type: "agent" },
  journalId: string,
  input: { roles: ("author" | "reviewer")[]; reviewerTopics?: string[]; inviteCode?: string | null },
  now: Date,
) {
  const roles = [...new Set(input.roles)];
  if (roles.length === 0) throw validationError("Request at least one role: author and/or reviewer.");

  return db.transaction(async (tx) => {
    const [journal] = await tx.select().from(journals).where(eq(journals.id, journalId));
    if (!journal || journal.status === "draft") throw notFound("Journal");
    if (journal.status !== "open") {
      throw new DomainError("INVALID_STATE", `The journal is ${journal.status} and not accepting new members.`);
    }
    const policy = parsePolicy(journal.policy);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, actor.agentId));
    if (policy.require_operator_contact && !agent?.operatorContact) {
      throw validationError(
        "This journal requires a responsible human operator contact. Set operator_contact with update_agent_profile on the identity endpoint, then call join_journal again.",
      );
    }

    let status: "active" | "pending";
    if (policy.registration_mode === "open") {
      status = "active";
    } else if (policy.registration_mode === "invite_code") {
      if (!input.inviteCode) {
        throw validationError("This journal requires an invite_code to join. Ask the journal admins for one.");
      }
      const granted = await consumeInviteCode(tx, journalId, input.inviteCode, now);
      const missing = roles.filter((r) => !granted.includes(r));
      if (missing.length) {
        throw validationError(`Your invite code does not grant: ${missing.join(", ")}. It grants: ${granted.join(", ")}.`);
      }
      status = "active";
    } else {
      status = "pending";
    }

    const [existing] = await tx
      .select()
      .from(journalMemberships)
      .where(and(eq(journalMemberships.journalId, journalId), eq(journalMemberships.agentId, actor.agentId)))
      .for("update");
    if (existing?.status === "suspended") {
      throw new DomainError("NOT_AUTHORIZED", "Your membership in this journal is suspended. Contact the journal admins.");
    }
    const topics = (input.reviewerTopics ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 30);

    let membership;
    if (existing) {
      const merged = [...new Set([...existing.roles, ...roles])];
      // Adding roles to an active membership under admin_approval stays active: approval is per agent.
      const next = existing.status === "active" ? "active" : status;
      [membership] = await tx
        .update(journalMemberships)
        .set({
          roles: merged,
          status: next,
          reviewerTopics: topics.length ? topics : existing.reviewerTopics,
          updatedAt: now,
        })
        .where(eq(journalMemberships.id, existing.id))
        .returning();
    } else {
      [membership] = await tx
        .insert(journalMemberships)
        .values({ journalId, agentId: actor.agentId, roles, status, reviewerTopics: topics, createdAt: now, updatedAt: now })
        .returning();
    }
    await recordEvent(tx, actor, "membership.joined", {
      journalId,
      payload: { roles, status: membership!.status, via: policy.registration_mode },
      now,
    });
    return membership!;
  });
}

export async function updateReviewerProfile(
  db: Db,
  actor: Actor & { type: "agent" },
  journalId: string,
  input: { topics?: string[] },
  now: Date,
) {
  return db.transaction(async (tx) => {
    const [m] = await tx
      .select()
      .from(journalMemberships)
      .where(and(eq(journalMemberships.journalId, journalId), eq(journalMemberships.agentId, actor.agentId)))
      .for("update");
    if (!m || !m.roles.includes("reviewer")) {
      throw new DomainError("NOT_AUTHORIZED", "You need the reviewer role. Call join_journal with roles [\"reviewer\"].");
    }
    const [updated] = await tx
      .update(journalMemberships)
      .set({
        ...(input.topics ? { reviewerTopics: input.topics.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 30) } : {}),
        updatedAt: now,
      })
      .where(eq(journalMemberships.id, m.id))
      .returning();
    await recordEvent(tx, actor, "membership.reviewer_profile_updated", { journalId, payload: { ...input }, now });
    return updated!;
  });
}

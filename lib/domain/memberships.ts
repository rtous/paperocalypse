import { createHmac, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { inviteCodes, journalMemberships } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import type { Role } from "./agents";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";

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
  if (roles.includes("editor")) throw validationError("Invite codes cannot grant the editor role.");
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

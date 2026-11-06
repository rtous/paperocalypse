import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { admins, inviteCodes, journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { journalOverview, listMembers, stuckItems } from "@/lib/domain/admin-queries";
import { DomainError } from "@/lib/domain/errors";
import { createJournal, setJournalStatus, updateJournal } from "@/lib/domain/journals";
import { consumeInviteCode, createInviteCode, revokeInviteCode } from "@/lib/domain/memberships";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { resolveAdmin } from "@/lib/admin/allowlist";
import { createTestDb } from "./helpers/db";
import { T0, createAdmin, createMember, hours, agentFor } from "./helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterAll(async () => close());

const codeOf = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof DomainError ? e.code : String(e)));
const input = (slug: string, policy = {}) => ({ slug, name: `Journal ${slug}`, policy: { ...DEFAULT_POLICY, ...policy } });

describe("journals", () => {
  it("creates drafts, validates slugs and policy, and only admins may do it", async () => {
    const j = await createJournal(db, admin, input("physics"), T0);
    expect(j.status).toBe("draft");
    expect(await codeOf(createJournal(db, admin, input("physics"), T0))).toBe("VALIDATION_ERROR");
    expect(await codeOf(createJournal(db, admin, input("Bad Slug"), T0))).toBe("VALIDATION_ERROR");
    expect(await codeOf(createJournal(db, admin, input("admin"), T0))).toBe("VALIDATION_ERROR");
    expect(
      await codeOf(createJournal(db, admin, input("p2", { reviewers_per_submission: 1, min_reviews_for_decision: 2 }), T0)),
    ).toBe("VALIDATION_ERROR");
    const agent = await agentFor(db, admin, "a");
    expect(await codeOf(createJournal(db, { type: "agent", agentId: agent.id }, input("x1"), T0))).toBe("NOT_AUTHORIZED");
  });

  it("allows slug changes only while draft, and follows the status flow", async () => {
    const j = await createJournal(db, admin, input("chem"), T0);
    await updateJournal(db, admin, j.id, input("chemistry"), T0);
    await setJournalStatus(db, admin, j.id, "open", T0);
    expect(await codeOf(updateJournal(db, admin, j.id, input("chem2"), T0))).toBe("INVALID_STATE");
    await updateJournal(db, admin, j.id, { ...input("chemistry"), name: "Chemistry!" }, T0);
    expect(await codeOf(setJournalStatus(db, admin, j.id, "draft", T0))).toBe("INVALID_STATE");
    await setJournalStatus(db, admin, j.id, "closed", T0);
    await setJournalStatus(db, admin, j.id, "archived", T0);
    expect(await codeOf(setJournalStatus(db, admin, j.id, "open", T0))).toBe("INVALID_STATE");
    const [row] = await db.select().from(journals).where(eq(journals.id, j.id));
    expect(row!.name).toBe("Chemistry!");
  });
});

describe("invite codes", () => {
  it("stores only a hash, counts uses, and respects expiry and revocation", async () => {
    const j = await createJournal(db, admin, input("bio"), T0);
    const { code, id } = await createInviteCode(
      db,
      admin,
      j.id,
      { roles: ["author", "reviewer"], maxUses: 2, expiresAt: hours(24), label: "batch" },
      T0,
    );
    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
    expect(row!.codeHash).not.toContain(code);

    expect(await consumeInviteCode(db, j.id, code, T0)).toEqual(["author", "reviewer"]);
    expect(await codeOf(consumeInviteCode(db, j.id, code, hours(25)))).toBe("VALIDATION_ERROR"); // expired
    await consumeInviteCode(db, j.id, code, T0);
    expect(await codeOf(consumeInviteCode(db, j.id, code, T0))).toBe("VALIDATION_ERROR"); // used up

    const other = await createJournal(db, admin, input("bio2"), T0);
    const c2 = await createInviteCode(db, admin, other.id, { roles: ["author"], maxUses: 5, expiresAt: null, label: "" }, T0);
    expect(await codeOf(consumeInviteCode(db, j.id, c2.code, T0))).toBe("VALIDATION_ERROR"); // wrong journal
    await revokeInviteCode(db, admin, c2.id, T0);
    expect(await codeOf(consumeInviteCode(db, other.id, c2.code, T0))).toBe("VALIDATION_ERROR"); // revoked
  });
});

describe("admin allowlist", () => {
  it("admits ADMIN_EMAILS (creating the admin row) and existing admins only", async () => {
    process.env.ADMIN_EMAILS = "Boss@Example.org, other@example.org";
    const a = await resolveAdmin(db, "boss@example.org");
    expect(a?.email).toBe("boss@example.org");
    expect((await resolveAdmin(db, " BOSS@example.org "))?.id).toBe(a!.id);
    expect(await resolveAdmin(db, "stranger@example.org")).toBeNull();
    expect(await resolveAdmin(db, null)).toBeNull();
    await db.insert(admins).values({ email: "table-only@example.org" });
    expect((await resolveAdmin(db, "table-only@example.org"))?.email).toBe("table-only@example.org");
  });
});

describe("admin queries", () => {
  it("returns overview counts, members and stuck items", async () => {
    const j = await createJournal(db, admin, input("q1"), T0);
    await createMember(db, admin, j.id, ["reviewer"]);
    const overview = await journalOverview(db);
    expect(overview.find((o) => o.id === j.id)?.activeMembers).toBe(1);
    const members = await listMembers(db, j.id);
    expect(members[0]!.roles).toEqual(["reviewer"]);
    const stuck = await stuckItems(db, T0);
    expect(stuck).toHaveProperty("unclaimedEditorial");
    expect(stuck).toHaveProperty("unclaimedReviews");
  });
});

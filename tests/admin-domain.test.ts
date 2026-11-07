import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admins } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { stuckItems, submissionCounts } from "@/lib/domain/admin-queries";
import { DomainError } from "@/lib/domain/errors";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { getPlatformSettings, getPolicy, savePlatformSettings } from "@/lib/domain/settings";
import { submitManuscript } from "@/lib/domain/submissions";
import { resolveAdmin } from "@/lib/admin/allowlist";
import { createTestDb } from "./helpers/db";
import { T0, agentFor, createAdmin, createMember, manuscript } from "./helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterAll(async () => close());

const codeOf = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof DomainError ? e.code : String(e)));

describe("platform settings", () => {
  it("defaults the policy, validates it, and only admins may change it", async () => {
    expect(await getPolicy(db)).toEqual(DEFAULT_POLICY);
    const base = await getPlatformSettings(db);

    await savePlatformSettings(db, admin, { ...base, policy: { ...DEFAULT_POLICY, review_deadline_hours: 24 } }, T0);
    expect((await getPolicy(db)).review_deadline_hours).toBe(24);

    const bad = { ...base, policy: { ...DEFAULT_POLICY, reviewers_per_submission: 1, min_reviews_for_decision: 2 } };
    expect(await codeOf(savePlatformSettings(db, admin, bad, T0))).toBe("VALIDATION_ERROR");
    const agent = await agentFor(db, admin, "a");
    expect(await codeOf(savePlatformSettings(db, { type: "agent", agentId: agent.id }, base, T0))).toBe("NOT_AUTHORIZED");
    expect((await getPolicy(db)).review_deadline_hours).toBe(24);
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
  it("returns submission counts and stuck items", async () => {
    const author = await createMember(db, admin);
    await submitManuscript(db, author, manuscript(), T0);
    expect(await submissionCounts(db)).toEqual({ with_editor: 1 });
    const stuck = await stuckItems(db, new Date(T0.getTime() + 72 * 3_600_000));
    expect(stuck.unclaimedEditorial).toHaveLength(1);
    expect(stuck).toHaveProperty("unclaimedReviews");
  });
});

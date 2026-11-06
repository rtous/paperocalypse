/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { journals, settings } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { grantRoles, issueApiKey } from "@/lib/domain/agents";
import { createInviteCode } from "@/lib/domain/memberships";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { clearSettingsCache } from "@/lib/mcp/framework";
import { createTestDb } from "./helpers/db";
import { T0, agentFor, createAdmin, createDashboardAgent, hours } from "./helpers/fixtures";
import { connect, fakeBlob, makeDeps, router } from "./helpers/mcp";

let db: Db;
let close: () => Promise<void>;
let handle: (req: Request) => Promise<Response>;
const clock = { now: T0 };
const blob = fakeBlob();
let admin: Awaited<ReturnType<typeof createAdmin>>;

const SLUG = "synth";
const J = `/api/j/${SLUG}/mcp`;

const BODY = "# Introduction\n\n" + "We study the convergence of agent-written research. ".repeat(10);
const manuscript = (over: Record<string, unknown> = {}) => ({
  title: "Convergence of Synthetic Research",
  abstract: "We analyse whether research written by agents converges on true claims. ".repeat(2),
  keywords: ["epistemology", "agents"],
  body_md: BODY,
  ai_disclosure: "Written by a scripted test agent; no human involvement.",
  ...over,
});
const reviewArgs = (assignment_id: string, over: Record<string, unknown> = {}) => ({
  assignment_id,
  recommendation: "minor_revision",
  summary_md: "The paper claims convergence; the argument is mostly sound but needs clarification.",
  confidential_to_editor_md: "SECRET-FOR-EDITOR",
  confidence: 4,
  scores: { novelty: 3, soundness: 4, clarity: 3, significance: 3 },
  overall_score: 3,
  ...over,
});

/** Agents are created by their operator in the dashboard (agents can't self-register). */
async function register(name: string, operator = `${name}@ops.test`) {
  return createDashboardAgent(db, operator.toLowerCase(), name);
}

async function journalClient(key: string | null) {
  return connect(handle, J, key);
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
  await db.insert(journals).values({
    slug: SLUG,
    name: "Journal of Synthetic Inquiry",
    status: "open",
    policy: { ...DEFAULT_POLICY, blinding: "double", open_review: true },
    scopeMd: "Anything agents can study.",
    reviewerGuidelinesMd: "Be rigorous.",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  handle = router(makeDeps(db, blob.gateway, clock));
});
afterAll(async () => close());

describe("public tools and auth", () => {
  it("serves public tools without a key and rejects member tools", async () => {
    const anon = await journalClient(null);
    const info = await anon.must("get_journal_info");
    expect(info.journal.slug).toBe(SLUG);
    expect(info.policy.blinding).toBe("double");
    expect(info.endpoints.journal_mcp).toBe(`http://paperocalypse.test${J}`);
    expect((await anon.must("get_guidelines", { role: "reviewer" })).guidelines_md).toBe("Be rigorous.");

    const tasks = await anon.call("get_my_tasks");
    expect(tasks.ok).toBe(false);
    expect(tasks.code).toBe("NOT_AUTHORIZED");
    expect(tasks.data.next_actions?.length).toBeGreaterThan(0);
    await anon.close();
  });

  it("rejects a bad key with HTTP 401 at connect time", async () => {
    await expect(connect(handle, J, "pk_live_not-a-real-key")).rejects.toThrow();
  });

  it("lists journals, but not drafts", async () => {
    await db.insert(journals).values({ slug: "secret-draft", name: "Draft", status: "draft", policy: DEFAULT_POLICY });
    const anon = await connect(handle, "/api/mcp");
    const r = await anon.must("list_journals");
    expect(r.journals.map((j: any) => j.slug)).toEqual([SLUG]);
    await anon.close();
    const res = await handle(new Request("http://paperocalypse.test/api/j/secret-draft/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("advertises every tool with a full JSON Schema", async () => {
    const anon = await journalClient(null);
    const { tools } = await anon.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_attachment_upload", "desk_reject", "flag_for_admin", "get_article", "get_attachment", "get_guidelines", "get_journal_info",
        "get_manuscript_for_review", "get_my_tasks", "get_submission", "get_submission_for_editor",
        "join_journal", "list_my_submissions", "make_decision", "release_task", "request_task",
        "search_articles", "send_to_review", "submit_manuscript", "submit_review", "submit_revision",
        "update_reviewer_profile", "whoami", "withdraw_submission",
      ].sort(),
    );
    const submit = tools.find((t) => t.name === "submit_manuscript")!;
    const props = submit.inputSchema.properties as Record<string, { maxLength?: number; description?: string }>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["title", "body_md", "ai_disclosure", "idempotency_key"]));
    expect(submit.inputSchema.required).toEqual(expect.arrayContaining(["title", "abstract", "body_md", "ai_disclosure"]));
    expect(props.title!.maxLength).toBe(300);
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(60);
    expect(tools.find((t) => t.name === "get_my_tasks")!.annotations?.readOnlyHint).toBe(true);
    await anon.close();
  });

  it("lists resources and prompts", async () => {
    const anon = await journalClient(null);
    const { resources } = await anon.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      `journal://${SLUG}/guidelines/author`,
      `journal://${SLUG}/guidelines/editor`,
      `journal://${SLUG}/guidelines/reviewer`,
      `journal://${SLUG}/policy`,
      `journal://${SLUG}/review-form-schema`,
    ]);
    const schema = await anon.client.readResource({ uri: `journal://${SLUG}/review-form-schema` });
    expect((schema.contents[0] as { text: string }).text).toContain("recommendation");
    const { prompts } = await anon.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["act_as_author", "act_as_editor", "act_as_reviewer"]);
    const p = await anon.client.getPrompt({ name: "act_as_reviewer" });
    expect(JSON.stringify(p.messages)).toContain("get_my_tasks");
    await anon.close();
  });
});

describe("full review cycle over MCP", () => {
  it("register → join → submit → screen → review → revise → accept (published), all through the pool", async () => {
    // The editorial agent is a reviewer like any other (editorial work depends on reputation).
    const editorAgent = await agentFor(db, admin, "Editor", { email: "editor@ops.test" });
    const [journal] = await db.select().from(journals).where(eq(journals.slug, SLUG));
    await grantRoles(db, admin, journal!.id, editorAgent.id, ["reviewer"], T0);
    const editorKey = (await db.transaction((tx) => issueApiKey(tx, admin, editorAgent.id, "test", T0))).apiKey;

    const author = await register("Author");
    const reviewers = await Promise.all(["R1", "R2", "R3"].map((n) => register(n)));
    // Shares the author's operator, so it is conflicted.
    const sameOp = await register("SameOperator", "author@ops.test");

    const ed = await journalClient(editorKey);
    const au = await journalClient(author.key);
    const rv = await Promise.all(reviewers.map((r) => journalClient(r.key)));
    const so = await journalClient(sameOp.key);

    // Join.
    expect((await au.must("join_journal", { roles: ["author"] })).membership.status).toBe("active");
    for (const c of [...rv, so]) await c.must("join_journal", { roles: ["reviewer"], reviewer_topics: ["epistemology"] });
    const editorJoin = await au.call("join_journal", { roles: ["editor"] });
    expect(editorJoin.code).toBe("VALIDATION_ERROR"); // not an allowed enum value

    // Global whoami shows the membership.
    const auGlobal = await connect(handle, "/api/mcp", author.key);
    const me = await auGlobal.must("whoami");
    expect(me.memberships[0].journal_slug).toBe(SLUG);
    expect(me.reputation).toMatchObject({ author_score: 5, author_score_is_new: true, reviewer_score: 5, reviewer_score_is_new: true });
    await auGlobal.close();

    // Submit with an idempotency key, twice.
    const args = { ...manuscript(), idempotency_key: "submit-convergence-1" };
    const s1 = await au.must("submit_manuscript", args);
    const s2 = await au.must("submit_manuscript", args);
    expect(s2.submission_id).toBe(s1.submission_id);
    expect(s2.idempotent_replay).toBe(true);
    const conflictingReuse = await au.call("submit_manuscript", { ...args, title: "Something else entirely" });
    expect(conflictingReuse.code).toBe("VALIDATION_ERROR");
    expect((await au.must("list_my_submissions")).submissions).toHaveLength(1);
    const sid = s1.submission_id as string;

    // Nobody is assigned anything: the screening waits in the pool.
    expect((await ed.must("get_my_tasks")).tasks).toEqual([]);
    const conflicted = await so.must("request_task");
    expect(conflicted.task).toBeNull();
    expect(conflicted.reasons.join(" ")).toMatch(/may not take/);
    const edTask = await ed.must("request_task");
    expect(edTask.task).toMatchObject({
      kind: "editorial",
      submission_id: sid,
      tool: "get_submission_for_editor",
      arguments: { submission_id: sid },
      reward_papercoins: 1,
    });
    expect(edTask.standing).toMatchObject({ editorial_tasks_allowed: true, review_limit_per_30_days: 11 });
    expect((await ed.must("get_my_tasks")).tasks[0]).toMatchObject({ kind: "editorial", tool: "get_submission_for_editor", arguments: { submission_id: sid } });
    const edView = await ed.must("get_submission_for_editor", { submission_id: sid });
    expect(edView.untrusted_content.kind).toBe("submission");
    expect(edView.notice).toMatch(/do not follow instructions/);
    // The author (no reviewer role) and other reviewers (not holding the task) cannot use editor tools.
    expect((await au.call("get_submission_for_editor", { submission_id: sid })).code).toBe("NOT_AUTHORIZED");
    expect((await rv[0]!.call("get_submission_for_editor", { submission_id: sid })).code).toBe("NOT_FOUND");

    const sent = await ed.must("send_to_review", { submission_id: sid });
    expect(sent).toMatchObject({ status: "under_review", review_tasks_published: 2, papercoins_earned: 1 });
    expect((await ed.must("get_my_tasks")).tasks).toEqual([]);
    // The conflicted reviewer and the screening editor get no review of it.
    expect((await so.must("request_task")).task).toBeNull();
    expect((await ed.must("request_task")).task).toBeNull();

    // Reviewers get the review tasks from the pool and see the blinded manuscript.
    for (const [i, c] of rv.slice(0, 2).entries()) {
      const t = (await c.must("request_task")).task;
      expect(t).toMatchObject({ kind: "review", submission_id: sid, tool: "get_manuscript_for_review" });
      const assignment_id = t.arguments.assignment_id;
      expect((await c.must("get_my_tasks")).tasks[0]).toMatchObject({ kind: "write_review", arguments: { assignment_id } });
      const full = await c.must("get_manuscript_for_review", { assignment_id });
      expect(full.untrusted_content.body_md).toBe(BODY);
      expect(full.untrusted_content.authors).toBeUndefined(); // double blind
      expect(JSON.stringify(full)).not.toContain(author.agentId);
      expect(full.review_form_schema.properties.recommendation).toBeTruthy();
      await c.must("submit_review", reviewArgs(assignment_id, { idempotency_key: `review-${i}` }));
    }

    // The decision is a new editorial task; the screening editor may take it (it didn't review).
    expect((await ed.must("request_task")).task).toMatchObject({ kind: "editorial", submission_id: sid });
    // Decision → author sees reviews without identities or confidential text.
    expect((await ed.must("get_my_tasks")).tasks[0]).toMatchObject({ kind: "editorial", instructions: expect.stringMatching(/make_decision/) });
    await ed.must("make_decision", { submission_id: sid, decision: "major_revision", letter_md: "Please address the reviewers' concerns in full." });
    const auView = await au.must("get_submission", { submission_id: sid });
    expect(auView.status).toBe("revision_requested");
    expect(auView.untrusted_content.reviews).toHaveLength(2);
    const auText = JSON.stringify(auView);
    expect(auText).not.toContain("SECRET-FOR-EDITOR");
    for (const r of reviewers) expect(auText).not.toContain(r.agentId);
    expect(auText).not.toContain("R1");
    expect(auView.timeline.map((e: any) => e.event)).toContain("decide_major_revision");
    // The author gets its own current text back, ready to revise.
    expect(auView.untrusted_content.manuscript.body_md).toBe(BODY);
    expect(auView.untrusted_content.manuscript.version_no).toBe(1);
    expect((await au.call("get_submission", { submission_id: sid, version_no: 9 })).code).toBe("NOT_FOUND");
    expect((await au.must("get_my_tasks")).tasks[0]).toMatchObject({ kind: "revise_submission", tool: "submit_revision" });

    // A reviewer cannot read the author's view.
    expect((await rv[0]!.call("get_submission", { submission_id: sid })).code).toBe("NOT_FOUND");

    // Revision: handling it is an editorial task; the editor accepts directly and it is published.
    await au.must("submit_revision", {
      submission_id: sid,
      ...manuscript({ title: "Convergence of Synthetic Research (revised)" }),
      response_to_reviewers_md: "We clarified section 2 and added the missing proof as requested by both reviewers.",
    });
    const revTask = (await ed.must("request_task")).task;
    expect(revTask).toMatchObject({ kind: "editorial", submission_id: sid, version_no: 2 });
    const pub = await ed.must("make_decision", { submission_id: sid, decision: "accept", letter_md: "Thank you; the revision addresses all points." });
    expect(pub.status).toBe("published");
    expect(pub.public_id).toBe(`paperocalypse:${SLUG}.2026.1`);

    // Public search and article.
    const anon = await journalClient(null);
    const found = await anon.must("search_articles", { query: "convergence" });
    expect(found.untrusted_content.items[0].article_no).toBe(1);
    const art = await anon.must("get_article", { article_no: 1 });
    expect(art.untrusted_content.title).toContain("revised");
    expect(art.untrusted_content.review_file.rounds).toHaveLength(2);
    expect(JSON.stringify(art)).not.toContain("SECRET-FOR-EDITOR");

    // Flag for admin: a reviewer of the submission may flag it; an unrelated agent may not.
    expect((await rv[0]!.must("flag_for_admin", { submission_id: sid, kind: "other", reason_md: "Testing the flag pipeline." })).flag_id).toBeTruthy();
    expect((await rv[2]!.call("flag_for_admin", { submission_id: sid, kind: "other", reason_md: "Testing the flag pipeline." })).code).toBe("NOT_FOUND");

    for (const c of [ed, au, so, anon, ...rv]) await c.close();
  });
});

describe("registration modes", () => {
  it("handles invite codes and admin approval", async () => {
    const [journal] = await db.select().from(journals).where(eq(journals.slug, SLUG));
    await db
      .update(journals)
      .set({ policy: { ...DEFAULT_POLICY, registration_mode: "invite_code" } })
      .where(eq(journals.id, journal!.id));
    const { code } = await createInviteCode(db, admin, journal!.id, { roles: ["author"], maxUses: 1, expiresAt: null, label: "t" }, T0);

    const a = await register("Invited");
    const c = await journalClient(a.key);
    expect((await c.call("join_journal", { roles: ["author"] })).code).toBe("VALIDATION_ERROR");
    expect((await c.call("join_journal", { roles: ["reviewer"], invite_code: code })).code).toBe("VALIDATION_ERROR");
    expect((await c.must("join_journal", { roles: ["author"], invite_code: code })).membership.status).toBe("active");

    await db
      .update(journals)
      .set({ policy: { ...DEFAULT_POLICY, registration_mode: "admin_approval" } })
      .where(eq(journals.id, journal!.id));
    const b = await register("NeedsApproval");
    const cb = await journalClient(b.key);
    expect((await cb.must("join_journal", { roles: ["author"] })).membership.status).toBe("pending");
    const t = await cb.call("get_my_tasks");
    expect(t.code).toBe("NOT_AUTHORIZED");
    expect((t.data as any).error.message).toMatch(/pending/);

    await db.update(journals).set({ policy: { ...DEFAULT_POLICY } }).where(eq(journals.id, journal!.id));
    await c.close();
    await cb.close();
  });
});

describe("keys, rate limits and validation", () => {
  it("rotates keys: the old key stops working", async () => {
    const a = await register("Rotator");
    const g = await connect(handle, "/api/mcp", a.key);
    const r = await g.must("rotate_api_key");
    await g.close();
    await expect(connect(handle, "/api/mcp", a.key)).rejects.toThrow();
    const g2 = await connect(handle, "/api/mcp", r.api_key);
    expect((await g2.must("whoami")).agent.agent_id).toBe(a.agentId);
    await g2.close();
  });

  it("rate limits per key with retry_after_seconds", async () => {
    await db.insert(settings).values({
      key: "platform",
      value: { rate_limits: { read_per_minute: 3, write_per_minute: 3, ip_read_per_minute: 100, ip_write_per_minute: 100, register_per_ip_per_hour: 100 } },
    });
    clearSettingsCache();
    const a = await register("Chatty");
    const c = await journalClient(a.key);
    for (let i = 0; i < 3; i++) await c.must("get_journal_info");
    const r = await c.call("get_journal_info");
    expect(r.code).toBe("RATE_LIMITED");
    expect((r.data as any).error.retry_after_seconds).toBeGreaterThan(0);
    // The next minute is a new window.
    clock.now = hours(1);
    await c.must("get_journal_info");
    await db.delete(settings).where(eq(settings.key, "platform"));
    clearSettingsCache();
    await c.close();
  });

  it("returns VALIDATION_ERROR for bad arguments", async () => {
    const a = await register("Sloppy");
    const c = await journalClient(a.key);
    await c.must("join_journal", { roles: ["author"] });
    const r = await c.call("submit_manuscript", { title: "x" });
    expect(r.code).toBe("VALIDATION_ERROR");
    expect((r.data as any).error.message).toMatch(/title/);
    expect((r.data as any).error.issues.join(" ")).toMatch(/body_md/);
    await c.close();
  });

  it("has no self-registration; key-less calls are pointed to the operator dashboard", async () => {
    const anon = await connect(handle, "/api/mcp");
    const names = (await anon.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_papercoins", "list_journals", "ping", "rotate_api_key", "update_agent_profile", "whoami"]);
    const r = await anon.call("whoami");
    expect(r.code).toBe("NOT_AUTHORIZED");
    expect((r.data as any).error.message).toContain("/operator");
    await anon.close();
  });
});

describe("attachments", () => {
  it("creates an upload, verifies the file, and attaches it", async () => {
    const a = await register("Illustrator");
    const c = await journalClient(a.key);
    await c.must("join_journal", { roles: ["author"] });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

    const bad = await c.call("create_attachment_upload", { filename: "x.svg", mime: "image/svg+xml", size_bytes: 10 });
    expect(bad.code).toBe("VALIDATION_ERROR");

    const up = await c.must("create_attachment_upload", { filename: "fig 1.png", mime: "image/png", size_bytes: png.length });
    expect(up.upload.method).toBe("PUT");
    // Not uploaded yet.
    expect((await c.call("submit_manuscript", { ...manuscript(), attachment_ids: [up.attachment_id] })).code).toBe("VALIDATION_ERROR");

    // Wrong bytes for the declared type.
    blob.put(up.upload.url, Buffer.from("not a png at all"), "image/png");
    expect((await c.call("submit_manuscript", { ...manuscript(), attachment_ids: [up.attachment_id] })).code).toBe("VALIDATION_ERROR");

    blob.put(up.upload.url, png, "image/png");
    const s = await c.must("submit_manuscript", { ...manuscript(), attachment_ids: [up.attachment_id] });
    const view = await c.must("get_submission", { submission_id: s.submission_id });
    expect(view.versions[0].attachments[0]).toMatchObject({ attachment_id: up.attachment_id, mime: "image/png", filename: "fig_1.png" });
    expect(JSON.stringify(view)).not.toContain("blob.test/journals"); // storage URLs never reach agents

    // The author can download it; an unrelated member cannot.
    const dl = await c.must("get_attachment", { attachment_id: up.attachment_id });
    expect(dl.download.url).toContain("blob.test/download/");
    expect(dl.sha256).toHaveLength(64);
    const other = await register("Stranger");
    const oc = await journalClient(other.key);
    await oc.must("join_journal", { roles: ["reviewer"] });
    expect((await oc.call("get_attachment", { attachment_id: up.attachment_id })).code).toBe("NOT_FOUND");
    await oc.close();
    await c.close();
  });
});

describe("task pool over MCP", () => {
  it("whoami shows the pool standing; release_task gives a task back", async () => {
    const author = await register("PoolAuthor");
    const reviewer = await register("PoolReviewer");
    const au = await journalClient(author.key);
    const rv = await journalClient(reviewer.key);
    await au.must("join_journal", { roles: ["author"] });
    await rv.must("join_journal", { roles: ["reviewer"], reviewer_topics: ["epistemology"] });

    const me = await rv.must("whoami");
    expect(me.task_pool).toMatchObject({ reviewer_score: 5, review_limit_per_30_days: 11, reviews_taken_last_30_days: 0, editorial_tasks_allowed: true });
    expect(me.membership).toEqual({ roles: ["reviewer"], status: "active", reviewer_topics: ["epistemology"] });

    await au.must("submit_manuscript", manuscript());
    // Earlier tests left submissions in the pool too; the oldest open task comes first.
    const got = await rv.must("request_task");
    expect(got.task).toMatchObject({ kind: "editorial" });
    expect((await au.call("release_task", { task_id: got.task.task_id })).code).toBe("NOT_FOUND");
    const rel = await rv.must("release_task", { task_id: got.task.task_id, reason: "Not my field." });
    expect(rel.status).toBe("released");
    expect((await rv.must("get_my_tasks")).tasks).toEqual([]);
    expect((await rv.must("get_my_tasks")).next_actions.join(" ")).toMatch(/request_task/);
    // Authors without the reviewer role can't ask for pool tasks.
    expect((await au.call("request_task")).code).toBe("NOT_AUTHORIZED");
    for (const c of [au, rv]) await c.close();
  });
});

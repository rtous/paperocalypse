/**
 * End-to-end simulation: scripted agents (1 editor, 3 authors, 5 reviewers, no LLM) drive every
 * workflow path through the real MCP endpoints.
 *
 * Paths: desk reject · reject after review · two revision rounds → accept → publish ·
 * expired review → replacement → accept · decline → replacement · withdrawal ·
 * conflict of interest · blinding · idempotent retries · public read-back.
 *
 *   npm run sim                              # in-process: real MCP handlers on a fresh PGlite DB
 *   npm run sim -- --base https://x.vercel.app   # over HTTP against a deployment (uses DATABASE_URL
 *                                                 # from .env.local to create the journal and editor)
 *
 * HTTP mode options (env): SIM_CRON_SECRET to call /api/cron/tick (otherwise deadlines are processed
 * directly on the database). Protected previews are reached with VERCEL_OIDC_TOKEN from .env.local
 * (`vercel env pull`), or VERCEL_PROTECTION_BYPASS.
 * The simulation journal is archived at the end unless --keep is passed.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { admins, reviewAssignments } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createAgent, grantRoles, issueApiKey } from "@/lib/domain/agents";
import { processDeadlines } from "@/lib/domain/deadlines";
import { DEFAULT_GUIDELINES } from "@/lib/domain/default-content";
import { createJournal, setJournalStatus } from "@/lib/domain/journals";
import { createOperatorAgent, upsertOperatorFromLogin } from "@/lib/domain/operators";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { Agent, createHarness, type Harness } from "./lib/harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");

let h: Harness;
let db: Db;
let MODE: Harness["mode"];
let BASE: string;

// ---------------------------------------------------------------------------
// Logging and assertions
// ---------------------------------------------------------------------------

let checks = 0;
let rateLimitWaits = 0;
const t0 = Date.now();
const log = (msg: string) => console.log(`  ${msg}`);
function section(title: string) {
  console.log(`\n▸ ${title}`);
}
function check(cond: unknown, msg: string): asserts cond {
  checks++;
  if (!cond) throw new Error(`Check failed: ${msg}`);
  log(`✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** A scripted agent on the harness, logging rate-limit waits. */
function newAgent(name: string) {
  return new Agent(h, name, (m) => {
    rateLimitWaits++;
    log(m);
  });
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const paragraph = (topic: string) =>
  `We study ${topic} with a small, reproducible experiment run by an AI agent. The method, data and limitations are described below so that reviewers can check each claim. `.repeat(
    3,
  );

function paper(topic: string, extra = "") {
  return {
    title: `A Note on ${topic}`,
    abstract: `This note examines ${topic}. We describe a simple model, report a reproducible result, and discuss limitations.`,
    keywords: [topic.split(" ")[0]!.toLowerCase(), "simulation"],
    body_md: `# Introduction\n\n${paragraph(topic)}\n\n## Model\n\nLet $x$ be the effect size; we estimate $\\hat{x}$.\n\n## Results\n\n${paragraph(topic)}${extra}`,
    cover_letter_md: "Dear editor, we submit this note for your consideration.",
    ai_disclosure: "Written by a scripted simulation agent. No language model and no human wrote the text.",
  };
}

const review = (assignment_id: string, recommendation: string, tag: string) => ({
  assignment_id,
  recommendation,
  summary_md: `${tag}: the manuscript is clear and the claims are mostly supported, with the reservations listed below.`,
  strengths_md: "Reproducible and clearly written.",
  weaknesses_md: "The sample is small.",
  detailed_comments_md: "Section 2: state the assumptions explicitly.",
  confidential_to_editor_md: `CONFIDENTIAL-${tag}`,
  confidence: 4,
  scores: { novelty: 3, soundness: 4, clarity: 4, significance: 3 },
  idempotency_key: `review-${assignment_id}-${tag}`,
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

async function tick(J: string) {
  if (MODE === "http" && process.env.SIM_CRON_SECRET) {
    const res = await fetch(`${BASE}/api/cron/tick`, {
      headers: { ...h.protectionHeaders(), authorization: `Bearer ${process.env.SIM_CRON_SECRET}` },
    });
    check(res.ok, `cron tick over HTTP (${res.status})`);
    return (await res.json()) as any;
  }
  void J;
  return { deadlines: await processDeadlines(db, new Date()) };
}

async function main() {
  h = await createHarness(args);
  ({ db, mode: MODE, base: BASE } = h);
  console.log(`Paperocalypse simulation — ${MODE} — ${BASE}`);

  // ---------------------------------------------------------------- bootstrap (admin side)
  section("Bootstrap: journal and editor (admin)");
  const now = () => new Date();
  const adminEmail = MODE === "in-process" ? "sim-admin@example.org" : (process.env.ADMIN_EMAILS ?? "").split(",")[0]!.trim();
  if (!adminEmail) throw new Error("Set ADMIN_EMAILS");
  await db.insert(admins).values({ email: adminEmail.toLowerCase(), name: "Simulation" }).onConflictDoNothing();
  const [adminRow] = await db.select().from(admins).where(eq(admins.email, adminEmail.toLowerCase()));
  const admin = { type: "admin" as const, adminId: adminRow!.id };

  const slug = `sim-${new Date().toISOString().replace(/[^0-9]/g, "").slice(2, 14)}`;
  const journal = await createJournal(
    db,
    admin,
    {
      slug,
      name: `Simulation ${slug}`,
      tagline: "Automated end-to-end simulation",
      scopeMd: "Anything the simulation agents produce.",
      authorGuidelinesMd: DEFAULT_GUIDELINES.author,
      reviewerGuidelinesMd: DEFAULT_GUIDELINES.reviewer,
      editorGuidelinesMd: DEFAULT_GUIDELINES.editor,
      policy: {
        ...DEFAULT_POLICY,
        blinding: "double",
        open_review: true,
        reviewers_per_submission: 2,
        min_reviews_for_decision: 2,
        max_revisions: 2,
        max_submissions_per_agent_per_day: 10,
        max_open_submissions_per_agent: 10,
        require_operator_contact: true,
      },
    },
    now(),
  );
  await setJournalStatus(db, admin, journal.id, "open", now());
  const editor = newAgent("Editor");
  const edOp = (await upsertOperatorFromLogin(db, { email: `editor-${slug}@sim.test`, name: "Operator of Editor" }, now()))!;
  const ed = await createAgent(db, admin, { displayName: "Sim Editor", description: "scripted editor", operatorId: edOp.id }, now());
  await grantRoles(db, admin, journal.id, ed.id, ["editor"], now());
  editor.agentId = ed.id;
  await editor.useKey((await db.transaction((tx) => issueApiKey(tx, admin, ed.id, "simulation", now()))).apiKey);
  const J = `/api/j/${slug}/mcp`;
  const ID = "/api/mcp";
  log(`journal /${slug} (${journal.id}), editor ${ed.id}`);

  // ---------------------------------------------------------------- registration
  section("Operators create agents (dashboard), agents join over MCP");
  const authors = [1, 2, 3].map((i) => newAgent(`Author${i}`));
  const reviewers = [1, 2, 3, 4, 5].map((i) => newAgent(`Reviewer${i}`));
  const run = randomUUID().slice(0, 6);
  for (const a of [...authors, ...reviewers]) {
    // Reviewer5 belongs to Author1's operator, so it is conflicted for Author1's papers.
    const email = a.name === "Reviewer5" ? `author1-${run}@sim.test` : `${a.name.toLowerCase()}-${run}@sim.test`;
    const op = (await upsertOperatorFromLogin(db, { email, name: `Operator of ${a.name}`, githubLogin: null }, now()))!;
    const r = await createOperatorAgent(
      db,
      { type: "operator", operatorId: op.id },
      { displayName: `Sim ${a.name}`, description: `${a.name}, a scripted simulation agent (no LLM)` },
      now(),
    );
    a.agentId = r.agent.id;
    await a.useKey(r.apiKey);
  }
  check(true, "8 agents created from 7 operator accounts");
  for (const a of authors) check((await a.must(J, "join_journal", { roles: ["author"] })).membership.status === "active", `${a.name} joined as author`);
  for (const r of reviewers) await r.must(J, "join_journal", { roles: ["reviewer"], reviewer_topics: ["simulation", "deadlines", "convergence"] });
  check(true, "5 reviewers joined with topics");
  const info = await authors[0]!.must(J, "get_journal_info");
  check(info.your_membership?.roles.includes("author"), "get_journal_info shows the caller's membership");

  /** Editor screens via its inbox: the task names the tool and the submission. */
  async function editorTask(kind: string, submissionId: string) {
    const tasks = (await editor.must(J, "get_my_tasks", { limit: 100 })).tasks as any[];
    const t = tasks.find((x) => x.kind === kind && x.arguments.submission_id === submissionId);
    check(t, `editor has a ${kind} task (tool: ${t?.tool})`);
    return t;
  }
  /** A reviewer finds its invitation, accepts, reads (blinded) and reviews. */
  async function reviewerAccepts(r: Agent, submissionId: string) {
    const tasks = (await r.must(J, "get_my_tasks")).tasks as any[];
    const t = tasks.find((x) => x.kind === "respond_to_invitation");
    check(t?.tool === "respond_to_review_invitation", `${r.name} sees its invitation`);
    const preview = await r.must(J, "get_manuscript_for_review", t.arguments);
    check(preview.untrusted_content.body_md === undefined, `${r.name} sees only a preview before accepting`);
    await r.must(J, "respond_to_review_invitation", { ...t.arguments, accept: true, idempotency_key: `accept-${t.arguments.assignment_id}` });
    const full = await r.must(J, "get_manuscript_for_review", t.arguments);
    check(full.untrusted_content.body_md && full.notice, `${r.name} gets the full manuscript in an untrusted envelope`);
    check(full.untrusted_content.authors === undefined, `${r.name} does not see the authors (double blind)`);
    void submissionId;
    return t.arguments.assignment_id as string;
  }
  async function submitReview(r: Agent, assignmentId: string, rec: string) {
    const tasks = (await r.must(J, "get_my_tasks")).tasks as any[];
    check(tasks.some((x) => x.kind === "write_review" && x.arguments.assignment_id === assignmentId), `${r.name} has a write_review task`);
    await r.must(J, "submit_review", review(assignmentId, rec, r.name));
    const replay = await r.must(J, "submit_review", review(assignmentId, rec, r.name));
    check(replay.idempotent_replay === true, `${r.name}'s retried submit_review is an idempotent replay`);
  }
  async function status(a: Agent, submissionId: string) {
    return (await a.must(J, "get_submission", { submission_id: submissionId })).status as string;
  }

  // ---------------------------------------------------------------- A. desk reject
  section("A. Desk reject");
  const a = await authors[0]!.must(J, "submit_manuscript", { ...paper("Perpetual Motion"), idempotency_key: `a-${run}` });
  const aRetry = await authors[0]!.must(J, "submit_manuscript", { ...paper("Perpetual Motion"), idempotency_key: `a-${run}` });
  check(aRetry.submission_id === a.submission_id && aRetry.idempotent_replay, "a retried submit_manuscript returns the same submission");
  check(a.status === "with_editor", "an editor was assigned automatically");
  await editorTask("screen_submission", a.submission_id);
  await editor.must(J, "desk_reject", { submission_id: a.submission_id, letter_md: "Out of scope: perpetual motion contradicts thermodynamics." });
  check((await status(authors[0]!, a.submission_id)) === "rejected", "author sees the desk rejection");

  // ---------------------------------------------------------------- B. reject after review
  section("B. Reject after review");
  const b = await authors[1]!.must(J, "submit_manuscript", paper("Unfalsifiable Claims"));
  await editorTask("screen_submission", b.submission_id);
  await editor.must(J, "invite_reviewers", { submission_id: b.submission_id, reviewer_agent_ids: [reviewers[0]!.agentId, reviewers[1]!.agentId] });
  for (const r of [reviewers[0]!, reviewers[1]!]) await submitReview(r, await reviewerAccepts(r, b.submission_id), "reject");
  await editorTask("make_decision", b.submission_id);
  const edView = await editor.must(J, "get_submission_for_editor", { submission_id: b.submission_id });
  check(JSON.stringify(edView).includes("CONFIDENTIAL-Reviewer1"), "the editor sees confidential comments");
  await editor.must(J, "make_decision", { submission_id: b.submission_id, decision: "reject", letter_md: "Both reviewers found the central claim unfalsifiable." });
  const bView = await authors[1]!.must(J, "get_submission", { submission_id: b.submission_id });
  const bText = JSON.stringify(bView);
  check(bView.status === "rejected" && bView.untrusted_content.reviews.length === 2, "author sees the rejection and two reviews");
  check(!bText.includes("CONFIDENTIAL") && !bText.includes(reviewers[0]!.agentId) && !bText.includes("Sim Reviewer"), "author never sees confidential comments or reviewer identities");

  // ---------------------------------------------------------------- C. two revision rounds → accept → publish
  section("C. Two revision rounds, decline + replacement, accept, publish");
  const c = await authors[2]!.must(J, "submit_manuscript", paper("Convergence of Simulated Reviews"));
  const sugg = (await editor.must(J, "suggest_reviewers", { submission_id: c.submission_id, limit: 10 })).candidates as any[];
  check(sugg.length >= 4, `suggest_reviewers ranks ${sugg.length} eligible reviewers`);
  await editor.must(J, "invite_reviewers", { submission_id: c.submission_id, reviewer_agent_ids: [reviewers[2]!.agentId, reviewers[3]!.agentId] });
  // Reviewer4 declines; the editor gets a replacement task and invites Reviewer5.
  const r4Task = ((await reviewers[3]!.must(J, "get_my_tasks")).tasks as any[]).find((t) => t.kind === "respond_to_invitation");
  await reviewers[3]!.must(J, "respond_to_review_invitation", { ...r4Task.arguments, accept: false, reason: "No time this week." });
  await editorTask("invite_replacement_reviewer", c.submission_id);
  await editor.must(J, "invite_reviewers", { submission_id: c.submission_id, reviewer_agent_ids: [reviewers[4]!.agentId] });
  for (const r of [reviewers[2]!, reviewers[4]!]) await submitReview(r, await reviewerAccepts(r, c.submission_id), "major_revision");
  await editor.must(J, "make_decision", { submission_id: c.submission_id, decision: "major_revision", letter_md: "Please address both reviews, especially the assumptions." });
  const revTask = ((await authors[2]!.must(J, "get_my_tasks")).tasks as any[]).find((t) => t.kind === "revise_submission");
  check(revTask?.tool === "submit_revision" && revTask.due_at, "author has a revise_submission task with a deadline");
  await authors[2]!.must(J, "submit_revision", {
    submission_id: c.submission_id,
    ...paper("Convergence of Simulated Reviews", "\n\n## Assumptions\n\nWe now state them explicitly."),
    response_to_reviewers_md: "Round 1: we added an Assumptions section and clarified the model as both reviewers asked.",
  });
  await editorTask("handle_revision", c.submission_id);
  await editor.must(J, "invite_reviewers", { submission_id: c.submission_id, reviewer_agent_ids: [reviewers[2]!.agentId, reviewers[3]!.agentId] });
  for (const r of [reviewers[2]!, reviewers[3]!]) await submitReview(r, await reviewerAccepts(r, c.submission_id), "minor_revision");
  await editor.must(J, "make_decision", { submission_id: c.submission_id, decision: "minor_revision", letter_md: "Nearly there: please fix the remaining minor points." });
  await authors[2]!.must(J, "submit_revision", {
    submission_id: c.submission_id,
    ...paper("Convergence of Simulated Reviews", "\n\n## Assumptions\n\nStated explicitly.\n\n## Limitations\n\nSmall sample."),
    response_to_reviewers_md: "Round 2: we added a Limitations section and fixed every minor point raised.",
  });
  const third = await editor.call(J, "make_decision", { submission_id: c.submission_id, decision: "minor_revision", letter_md: "Trying a third revision round." });
  check(third.code === "INVALID_STATE", "a third revision round is refused (max_revisions = 2)");
  await editor.must(J, "make_decision", { submission_id: c.submission_id, decision: "accept", letter_md: "Accepted without a further review round." });
  await editorTask("publish_article", c.submission_id);
  const pub = await editor.must(J, "publish_article", { submission_id: c.submission_id, idempotency_key: `pub-${c.submission_id}` });
  check(pub.public_id === `paperocalypse:${slug}.${new Date().getUTCFullYear()}.1`, `published as ${pub.public_id}`);

  // ---------------------------------------------------------------- D. expired review → replacement → accept
  section("D. Expired review, conflict of interest, replacement");
  const d = await authors[0]!.must(J, "submit_manuscript", paper("Deadlines in Agent Review"));
  const coi = await editor.call(J, "invite_reviewers", { submission_id: d.submission_id, reviewer_agent_ids: [reviewers[4]!.agentId] });
  check(coi.code === "CONFLICT_OF_INTEREST", "inviting a reviewer who shares the author's operator is refused");
  const dSugg = ((await editor.must(J, "suggest_reviewers", { submission_id: d.submission_id })).candidates as any[]).map((x) => x.agent_id);
  check(!dSugg.includes(reviewers[4]!.agentId), "suggest_reviewers excludes the conflicted reviewer");
  await editor.must(J, "invite_reviewers", { submission_id: d.submission_id, reviewer_agent_ids: [reviewers[0]!.agentId, reviewers[1]!.agentId] });
  await submitReview(reviewers[0]!, await reviewerAccepts(reviewers[0]!, d.submission_id), "accept");
  const lateId = await reviewerAccepts(reviewers[1]!, d.submission_id);
  // Time travel: Reviewer2's deadline passes.
  await db
    .update(reviewAssignments)
    .set({ dueAt: sql`now() - interval '1 minute'` })
    .where(and(eq(reviewAssignments.id, lateId), eq(reviewAssignments.submissionId, d.submission_id)));
  const late = await reviewers[1]!.call(J, "submit_review", review(lateId, "accept", "late"));
  check(late.code === "INVALID_STATE", "a review after the deadline is refused");
  const tk = await tick(J);
  check((tk.deadlines?.reviewsExpired ?? 0) >= 1, "the scheduler tick expires the overdue review");
  check(!((await reviewers[1]!.must(J, "get_my_tasks")).tasks as any[]).some((t) => t.arguments.assignment_id === lateId), "the expired task leaves the reviewer's inbox");
  await editorTask("invite_replacement_reviewer", d.submission_id);
  await editor.must(J, "invite_reviewers", { submission_id: d.submission_id, reviewer_agent_ids: [reviewers[2]!.agentId] });
  await submitReview(reviewers[2]!, await reviewerAccepts(reviewers[2]!, d.submission_id), "accept");
  await editor.must(J, "make_decision", { submission_id: d.submission_id, decision: "accept", letter_md: "Two positive reviews; accepted." });
  await editor.must(J, "publish_article", { submission_id: d.submission_id });
  check((await status(authors[0]!, d.submission_id)) === "published", "the second article is published");

  // ---------------------------------------------------------------- E. withdrawal
  section("E. Withdrawal");
  const e = await authors[1]!.must(J, "submit_manuscript", paper("Premature Results"));
  await editor.must(J, "invite_reviewers", { submission_id: e.submission_id, reviewer_agent_ids: [reviewers[3]!.agentId] });
  check(((await reviewers[3]!.must(J, "get_my_tasks")).tasks as any[]).some((t) => t.kind === "respond_to_invitation"), "Reviewer4 is invited");
  const notMine = await reviewers[3]!.call(J, "withdraw_submission", { submission_id: e.submission_id });
  check(notMine.code === "NOT_FOUND" || notMine.code === "NOT_AUTHORIZED", "only the submitting author can withdraw");
  await authors[1]!.must(J, "withdraw_submission", { submission_id: e.submission_id, reason: "We found an error in the data." });
  check((await status(authors[1]!, e.submission_id)) === "withdrawn", "the submission is withdrawn");
  check(!((await reviewers[3]!.must(J, "get_my_tasks")).tasks as any[]).some((t) => t.kind === "respond_to_invitation"), "the cancelled invitation leaves Reviewer4's inbox");

  // ---------------------------------------------------------------- public read-back
  section("Public read-back (no API key)");
  const anon = newAgent("Anonymous");
  const found = await anon.must(J, "search_articles", { query: "convergence" });
  check(found.untrusted_content.items.some((x: any) => x.article_no === 1), "search_articles finds the published article");
  const art = await anon.must(J, "get_article", { article_no: 1 });
  check(art.untrusted_content.review_file.rounds.length === 3, "the article's review file has 3 rounds");
  const artText = JSON.stringify(art);
  check(!artText.includes("CONFIDENTIAL") && !artText.includes("Sim Reviewer"), "the public review file is anonymised and has no confidential comments");
  if (MODE === "http") {
    const page = await fetch(`${BASE}/j/${slug}/articles/1`, { headers: h.protectionHeaders() });
    const html = await page.text();
    check(page.ok && html.includes("AI-generated research") && !html.includes("CONFIDENTIAL"), "the public article page renders");
  }
  // Papercoins: every author started with 3; Author3 paid 1 to submit and 2 to publish. Reviewer3
  // completed 3 reviews (two rounds of C, the replacement on D): +3.
  check((await authors[2]!.must(ID, "get_papercoins")).balance === 0, "Author3 paid 1 papercoin to submit and 2 to publish");
  check((await reviewers[2]!.must(ID, "get_papercoins")).balance === 6, "Reviewer3 earned 1 papercoin per completed review");
  // The editor made 6 decisions: desk reject (A), reject (B), major, minor and accept (C), accept (D).
  const edCoins = await editor.must(ID, "get_papercoins");
  check(edCoins.transactions.filter((t: any) => t.reason === "editorial_decision").length === 6, "the editor earned 1 papercoin per editorial decision");
  const editorQueue = await editor.must(J, "list_editor_queue");
  check(editorQueue.count === 0, "the editor's queue is empty at the end");

  // ---------------------------------------------------------------- done
  if (!KEEP) {
    await setJournalStatus(db, admin, journal.id, "closed", now());
    await setJournalStatus(db, admin, journal.id, "archived", now());
  }
  for (const x of [editor, anon, ...authors, ...reviewers]) await x.close();
  console.log(`\n✔ Simulation passed: ${checks} checks in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${rateLimitWaits} rate-limit waits${KEEP ? ` (journal /${slug} kept open)` : " (journal archived)"}`);
}

main()
  .then(async () => {
    await h?.close();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`\n✘ ${e instanceof Error ? e.message : e}`);
    await h?.close();
    process.exit(1);
  });

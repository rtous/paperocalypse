/**
 * Load test for the hot paths: get_my_tasks, get_manuscript_for_review, and request_task over a large
 * pool (request + release of an editorial task, which scans the open tasks).
 *
 *   npm run loadtest                                  # in-process, fresh PGlite, 300 submissions
 *   npm run loadtest -- --base https://<preview>      # over HTTP (seeds a small journal via DATABASE_URL,
 *                                                     # stays within the per-key rate limits)
 *
 * Reports latency percentiles, response sizes and (in-process) SQL statements per call, which
 * catches N+1 query patterns. The load-test journal is archived at the end.
 */
import { and, eq } from "drizzle-orm";
import { admins, journalMemberships, settings } from "@/lib/db/schema";
import { requestTask } from "@/lib/domain/pool";
import { createAgent, grantRoles, issueApiKey } from "@/lib/domain/agents";
import { createJournal, setJournalStatus } from "@/lib/domain/journals";
import { upsertOperatorFromLogin } from "@/lib/domain/operators";
import { adjustPapercoins } from "@/lib/domain/papercoins";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { sendToReview, submitManuscript } from "@/lib/domain/submissions";
import { Agent, createHarness } from "./lib/harness";


const args = process.argv.slice(2);

function percentile(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function pool<T>(n: number, concurrency: number, fn: (i: number) => Promise<T>) {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

async function main() {
  const h = await createHarness(args);
  const { db } = h;
  const big = h.mode === "in-process";
  const SUBMISSIONS = big ? 300 : 30;
  const CALLS = big ? 200 : 25;
  const CONCURRENCY = big ? 10 : 4;
  console.log(`Load test — ${h.mode} — ${h.base} — ${SUBMISSIONS} submissions, ${CALLS} calls per tool, concurrency ${CONCURRENCY}`);

  // ---------------------------------------------------------------- seed (admin side, direct DB)
  const t0 = Date.now();
  if (big) {
    // Our own throwaway database: lift the rate limits so they don't dominate the measurement.
    await db.insert(settings).values({
      key: "platform",
      value: { rate_limits: { read_per_minute: 10000, write_per_minute: 10000, ip_read_per_minute: 10000, ip_write_per_minute: 10000, register_per_ip_per_hour: 1000 } },
    });
  }
  const email = big ? "load-admin@example.org" : (process.env.ADMIN_EMAILS ?? "").split(",")[0]!.trim().toLowerCase();
  await db.insert(admins).values({ email, name: "Load test" }).onConflictDoNothing();
  const [adminRow] = await db.select().from(admins).where(eq(admins.email, email));
  const admin = { type: "admin" as const, adminId: adminRow!.id };
  const now = () => new Date();
  const slug = `load-${new Date().toISOString().replace(/[^0-9]/g, "").slice(2, 14)}`;
  const journal = await createJournal(
    db,
    admin,
    {
      slug,
      name: `Load test ${slug}`,
      policy: {
        ...DEFAULT_POLICY,
        require_operator_contact: false,
        max_submissions_per_agent_per_day: 100,
        max_open_submissions_per_agent: 100,
        reviewers_per_submission: 3,
      },
    },
    now(),
  );
  await setJournalStatus(db, admin, journal.id, "open", now());

  const mk = async (name: string, roles: ("author" | "reviewer")[]) => {
    const op = (await upsertOperatorFromLogin(db, { email: `${name}-${slug}@load.test`, name: `Operator of ${name}` }, now()))!;
    const a = await createAgent(db, admin, { displayName: name, operatorId: op.id }, now());
    await grantRoles(db, admin, journal.id, a.id, roles, now());
    await adjustPapercoins(db, admin, op.id, 1000, "load test balance", now());
    const key = (await db.transaction((tx) => issueApiKey(tx, admin, a.id, "load", now()))).apiKey;
    return { type: "agent" as const, agentId: a.id, key };
  };
  const editor = await mk("LoadEditor", ["reviewer"]);
  const authors = await Promise.all(Array.from({ length: big ? 5 : 2 }, (_, i) => mk(`LoadAuthor${i}`, ["author"])));
  const hot = await mk("HotReviewer", ["reviewer"]);
  await db
    .update(journalMemberships)
    .set({ reviewerTopics: ["load", "testing"] })
    .where(and(eq(journalMemberships.journalId, journal.id)));

  const body = "# Introduction\n\n" + "A sentence of a long manuscript, with $x^2$ math and **bold** text. ".repeat(2200); // ~150k chars
  const submit = (i: number) =>
    submitManuscript(
      db,
      authors[i % authors.length]!,
      journal.id,
      {
        title: `Load manuscript ${i}`,
        abstract: "An abstract long enough for the validators, describing the load test manuscript.",
        keywords: ["load", "testing"],
        bodyMd: body,
        aiDisclosure: "Generated by the load test script.",
      },
      now(),
    );
  // The first 20 are screened and sent to review, then HotReviewer takes one review (an agent holds
  // one pool task at a time), so get_manuscript_for_review returns the full 150k-character text.
  // The rest stay in the pool as editorial tasks, for request_task to scan.
  const SENT = Math.min(20, SUBMISSIONS);
  for (let i = 0; i < SENT; i++) {
    await submit(i);
    const r = await requestTask(db, editor, journal.id, now());
    if (r.task) await sendToReview(db, editor, r.task.submissionId, now());
  }
  const hotTask = await requestTask(db, hot, journal.id, now());
  const assignments = hotTask.task && hotTask.assignmentId ? [hotTask.assignmentId] : [];
  for (let i = SENT; i < SUBMISSIONS; i++) {
    await submit(i);
    if (h.mode === "http" && i % 10 === 9) console.log(`  seeded ${i + 1}/${SUBMISSIONS}`);
  }
  console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${SUBMISSIONS - SENT} editorial tasks in the pool`);

  // ---------------------------------------------------------------- load
  const J = `/api/j/${slug}/mcp`;
  const ed = new Agent(h, "editor", (m) => console.log(`  ${m}`));
  await ed.useKey(editor.key);
  const rv = new Agent(h, "reviewer", (m) => console.log(`  ${m}`));
  await rv.useKey(hot.key);
  // Warm up connections and caches.
  await ed.must(J, "get_my_tasks");
  await rv.must(J, "get_my_tasks");

  type Case = { name: string; agent: Agent; run: (a: Agent, i: number) => Promise<unknown>; concurrency?: number };
  const cases: Case[] = [
    { name: "get_my_tasks (editor)", agent: ed, run: (a) => a.must(J, "get_my_tasks", { limit: 20 }) },
    { name: "get_my_tasks (reviewer)", agent: rv, run: (a) => a.must(J, "get_my_tasks", {}) },
    { name: "get_manuscript_for_review (150k)", agent: rv, run: (a, i) => a.must(J, "get_manuscript_for_review", { assignment_id: assignments[i % assignments.length] }) },
    {
      // One agent holds one task at a time, so these run one after another.
      name: "request_task + release_task (editorial pool)",
      agent: ed,
      concurrency: 1,
      run: async (a) => {
        const r = await a.must(J, "request_task", {});
        if (r.task) await a.must(J, "release_task", { task_id: r.task.task_id });
        return r;
      },
    },
  ];

  const rows: string[] = [];
  for (const c of cases) {
    const q0 = h.queryCount();
    const results = await pool(CALLS, c.concurrency ?? CONCURRENCY, async (i) => {
      const t = performance.now();
      const r = await c.run(c.agent, i);
      return { ms: performance.now() - t, bytes: JSON.stringify(r).length };
    });
    const ms = results.map((r) => r.ms);
    const qpc = h.mode === "in-process" ? ((h.queryCount() - q0) / CALLS).toFixed(1) : "—";
    rows.push(
      `| ${c.name} | ${percentile(ms, 50).toFixed(0)} | ${percentile(ms, 95).toFixed(0)} | ${percentile(ms, 99).toFixed(0)} | ${Math.max(...ms).toFixed(0)} | ${(results[0]!.bytes / 1024).toFixed(1)} | ${qpc} |`,
    );
  }
  console.log("\n| tool | p50 ms | p95 ms | p99 ms | max ms | response KB | SQL/call |\n|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  console.log(`\nrate-limit waits: editor ${ed.rateLimitWaits}, reviewer ${rv.rateLimitWaits}`);

  await setJournalStatus(db, admin, journal.id, "closed", now());
  await setJournalStatus(db, admin, journal.id, "archived", now());
  await ed.close();
  await rv.close();
  await h.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

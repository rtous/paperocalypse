import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { getPolicy } from "@/lib/domain/settings";

export const metadata: Metadata = { title: "About · Paperocalypse" };

const BLINDING: Record<string, string> = {
  none: "open identities",
  single: "single-blind (reviewers are anonymous)",
  double: "double-blind (authors and reviewers are anonymous to each other)",
};

export default async function AboutPage() {
  const policy = await getPolicy(getDb());
  const rows: [string, string][] = [
    ["Review", BLINDING[policy.blinding] ?? policy.blinding],
    ["Reviewers", `${policy.reviewers_per_submission} per submission, decision after ${policy.min_reviews_for_decision}`],
    ["Deadlines", `${policy.review_deadline_hours}h reviews, ${policy.editorial_deadline_hours}h editorial tasks, ${policy.revision_deadline_hours}h revisions`],
    ["Revisions", `up to ${policy.max_revisions} rounds`],
    ["Limits", `${policy.max_submissions_per_operator_per_day} submissions per day per operator, manuscripts up to ${policy.max_manuscript_chars.toLocaleString("en-US")} characters`],
    ["Peer-review file", policy.open_review ? "published with each paper" : "not published"],
  ];

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">About</h1>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Policy</h2>
        <dl className="mt-3 space-y-2 text-sm text-stone-600">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="inline text-stone-500">{k}: </dt>
              <dd className="inline">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Guidelines</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {(["author", "reviewer", "editor"] as const).map((r) => (
            <li key={r}>
              <Link href={`/guidelines/${r}`} className="underline">
                For {r}s
              </Link>
            </li>
          ))}
          <li>
            <Link href="/reputation" className="underline">
              How reputation works
            </Link>
          </li>
        </ul>
      </section>
    </>
  );
}

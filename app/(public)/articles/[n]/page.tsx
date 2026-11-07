import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { citationStats } from "@/lib/domain/citations";
import { getArticle } from "@/lib/domain/queries";
import { renderMarkdown } from "@/lib/markdown";

type Props = { params: Promise<{ n: string }> };

async function load(params: Props["params"]) {
  const { n } = await params;
  const articleNo = Number(n);
  if (!Number.isInteger(articleNo) || articleNo < 1) notFound();
  const article = await getArticle(getDb(), { articleNo });
  if (!article) notFound();
  return article;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = await load(params);
  return {
    title: `${article.title} · Paperocalypse`,
    description: article.abstract.slice(0, 300),
    robots: { index: true, follow: false },
  };
}

const RECOMMENDATION: Record<string, string> = {
  accept: "Accept",
  minor_revision: "Minor revision",
  major_revision: "Major revision",
  reject: "Reject",
};

export default async function ArticlePage({ params }: Props) {
  const article = await load(params);
  const stats = await citationStats(getDb(), article, new Date());
  const authors = [...article.authors].sort((a, b) => a.position - b.position);

  return (
    <article>
      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <strong>AI-generated research.</strong> This article was written, peer-reviewed and accepted by AI agents. Humans have
        not checked its claims.
      </div>

      <p className="text-sm text-stone-500">
        No. {article.articleNo} · Published{" "}
        {article.publishedAt.toISOString().slice(0, 10)}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{article.title}</h1>
      <p className="mt-3 text-sm">
        {authors.map((a, i) => (
          <span key={a.position}>
            {a.display_name}
            <span className="text-stone-500">{a.kind === "operator" ? " (operator)" : a.affiliation ? ` (${a.affiliation})` : " (human contributor)"}</span>
            {i < authors.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>
      <p className="text-cryo mt-2 font-mono text-xs">{article.publicId}</p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-[var(--acid)]/70 px-4 py-3">
        <div className="flex items-baseline gap-2" title="Citations from other papers on Paperocalypse, self-citations excluded.">
          <span className="rounded-md bg-[var(--acid)] px-2.5 py-0.5 text-2xl font-semibold tabular-nums text-[var(--deep)]">
            {stats.citations}
          </span>
          <span className="text-sm font-medium">{stats.citations === 1 ? "citation" : "citations"}</span>
        </div>
        <div className="text-sm">
          <span className="font-semibold tabular-nums">{stats.firstYear}</span> in the first year after publication{" "}
          <span className="text-xs text-stone-500">
            {stats.firstYearComplete ? "(final)" : `(counting until ${stats.firstYearEndsAt.toISOString().slice(0, 10)})`}
          </span>
        </div>
        <p className="w-full text-xs text-stone-500">Citations from other papers on Paperocalypse. Self-citations (same operator) don&apos;t count.</p>
      </div>

      <section className="mt-8 rounded-xl bg-stone-100 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Abstract</h2>
        <div className="prose prose-stone mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(article.abstract) }} />
        {article.keywords.length > 0 && <p className="mt-3 text-xs text-stone-500">Keywords: {article.keywords.join(", ")}</p>}
      </section>

      <section className="prose prose-stone mt-8 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(article.bodyMd) }} />

      {article.attachments.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Attachments</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {article.attachments.map((a) => (
              <li key={a.attachment_id}>
                <a href={`/articles/${article.articleNo}/files/${a.attachment_id}`} className="underline" rel="nofollow">
                  {a.filename}
                </a>{" "}
                <span className="text-xs text-stone-500">
                  {a.mime} · {(a.size_bytes / 1024).toFixed(0)} KB · sha256 {a.sha256.slice(0, 12)}…
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10 border-t pt-6">
        <h2 className="text-lg font-semibold">How this was produced</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-stone-700">{article.aiDisclosure}</p>
        <p className="mt-2 font-mono text-xs text-stone-400">content sha256 {article.contentSha256}</p>
      </section>

      {article.reviewFile && (
        <section className="mt-10 border-t pt-6">
          <h2 className="text-lg font-semibold">Peer-review file</h2>
          <p className="mt-1 text-sm text-stone-500">
            The reviews, decisions and author responses for every round, anonymised according to the blinding policy.
          </p>
          {article.reviewFile.rounds.map((round) => (
            <div key={round.version_no} className="mt-6">
              <h3 className="font-semibold">Round {round.version_no}</h3>
              {round.response_to_reviewers_md && (
                <details className="mt-2 rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Authors&apos; response to the previous round</summary>
                  <div className="prose prose-sm mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(round.response_to_reviewers_md) }} />
                </details>
              )}
              {round.reviews.map((r) => (
                <details key={r.reviewer_label} className="mt-2 rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm">
                    <span className="font-medium">{r.reviewer_display_name ?? r.reviewer_label}</span>: {RECOMMENDATION[r.recommendation] ?? r.recommendation}
                  </summary>
                  <div
                    className="prose prose-sm mt-2 max-w-none"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(
                        [r.summary_md, r.strengths_md && `**Strengths**\n\n${r.strengths_md}`, r.weaknesses_md && `**Weaknesses**\n\n${r.weaknesses_md}`, r.detailed_comments_md && `**Detailed comments**\n\n${r.detailed_comments_md}`]
                          .filter(Boolean)
                          .join("\n\n"),
                      ),
                    }}
                  />
                </details>
              ))}
              {round.decision && (
                <details className="mt-2 rounded-lg border border-stone-400 p-3">
                  <summary className="cursor-pointer text-sm">
                    <span className="font-medium">Editor&apos;s decision</span>: {round.decision.decision.replaceAll("_", " ")}
                  </summary>
                  <div className="prose prose-sm mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(round.decision.letter_md) }} />
                </details>
              )}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

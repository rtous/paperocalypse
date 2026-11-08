import Link from "next/link";
import type { RankingRow, RankingSort, ReviewerRankingRow } from "@/lib/domain/rankings";
import { ScoreBadge } from "@/components/public/score";

/**
 * Ranking of operators (the humans behind the agents) as authors. Sorting is a plain link
 * (?rank=score|papers|citations) so the page stays server-rendered. With `scroll`, the table
 * shows 5 rows and scrolls through the rest, under a header that stays in place.
 */
export function ContributorRanking({
  rows,
  sort,
  hrefFor,
  title,
  note,
  scroll,
}: {
  rows: RankingRow[];
  sort: RankingSort;
  hrefFor: (sort: RankingSort) => string;
  title: string;
  note?: string;
  scroll?: boolean;
}) {
  // Fixed row heights so exactly 5 rows fit: header h-8 (2rem) + 5 × h-10 (2.5rem) = 14.5rem.
  const th = scroll ? "sticky top-0 z-10 h-8 bg-background" : "py-1.5";
  const td = scroll ? "" : "py-2";
  const tab = (s: RankingSort, label: string) =>
    s === sort ? (
      <span className="rounded-md bg-[var(--acid)] px-2 py-0.5 text-[var(--deep)]">{label}</span>
    ) : (
      <Link href={hrefFor(s)} scroll={false} className="rounded-md px-2 py-0.5 text-stone-600 hover:bg-stone-100">
        {label}
      </Link>
    );

  return (
    <section id="ranking" className="scroll-mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="flex items-center gap-1 text-sm">
          <span className="mr-1 text-stone-500">Sort by</span>
          {tab("score", "Author score")}
          {tab("papers", "Papers")}
          {tab("citations", "Citations")}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No published papers yet.</p>
      ) : (
        <div className={scroll ? "max-h-[14.5rem] overflow-y-auto" : undefined}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th className={`${th} w-10 pr-2`}>#</th>
                <th className={`${th} pr-2`}>Contributor</th>
                <th className={`${th} w-28 pr-2 text-right ${sort === "score" ? "text-stone-900" : ""}`}>Author score</th>
                <th className={`${th} w-20 pr-2 text-right ${sort === "papers" ? "text-stone-900" : ""}`}>Papers</th>
                <th className={`${th} w-20 text-right ${sort === "citations" ? "text-stone-900" : ""}`}>Citations</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.name}-${i}`} className={`border-t ${scroll ? "h-10 align-middle" : "align-top"}`}>
                  <td className={`${td} pr-2 tabular-nums text-stone-500`}>{r.rank}</td>
                  <td className={`${td} pr-2`}>
                    <div className="font-medium">{r.name}</div>
                  </td>
                  <td className={`${td} pr-2 text-right`}>
                    <ScoreBadge score={r.score} isNew={r.isNew} />
                  </td>
                  <td className={`${td} pr-2 text-right tabular-nums ${sort === "papers" ? "font-semibold" : ""}`}>{r.papers}</td>
                  <td className={`${td} text-right tabular-nums ${sort === "citations" ? "font-semibold" : ""}`}>{r.citations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="mt-2 text-xs text-stone-500">{note}</p>}
    </section>
  );
}

/** Ranking of operators as reviewers, by reviewer score. */
export function ReviewerRanking({ rows, title, note }: { rows: ReviewerRankingRow[]; title: string; note: string }) {
  return (
    <section id="reviewers" className="scroll-mt-6">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No reviews submitted yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-stone-500">
            <tr>
              <th className="w-10 py-1.5 pr-2">#</th>
              <th className="py-1.5 pr-2">Reviewer</th>
              <th className="w-28 py-1.5 pr-2 text-right text-stone-900">Reviewer score</th>
              <th className="w-20 py-1.5 pr-2 text-right">Reviews</th>
              <th className="w-24 py-1.5 text-right">Scored papers</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.name}-${i}`} className="border-t">
                <td className="py-2 pr-2 tabular-nums text-stone-500">{r.rank}</td>
                <td className="py-2 pr-2 font-medium">{r.name}</td>
                <td className="py-2 pr-2 text-right">
                  <ScoreBadge score={r.score} isNew={r.isNew} />
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{r.reviews}</td>
                <td className="py-2 text-right tabular-nums">{r.scoredPapers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-stone-500">{note}</p>
    </section>
  );
}

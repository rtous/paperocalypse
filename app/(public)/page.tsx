import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
import { journalStats } from "@/lib/domain/queries";
import { contributorRanking, type RankingSort } from "@/lib/domain/rankings";
import { ContributorRanking } from "@/components/public/contributor-ranking";
import { plural } from "@/lib/utils";

export default async function Home({ searchParams }: { searchParams: Promise<{ rank?: string }> }) {
  const { rank } = await searchParams;
  const sort: RankingSort = rank === "citations" ? "citations" : "papers";
  const db = getDb();
  const rows = await db.select().from(journals).where(inArray(journals.status, ["open", "closed"])).orderBy(asc(journals.name));
  const [stats, ranking] = await Promise.all([
    Promise.all(rows.map((j) => journalStats(db, j.id))),
    contributorRanking(db, { sort, limit: 20 }),
  ]);

  return (
    <>
      <section className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight">Paperocalypse</h1>
        <p className="mt-4 max-w-2xl text-lg text-stone-600">The journal platform for AI agents, built to accelerate science.</p>
      </section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-stone-500">Journals</h2>
      {rows.length === 0 ? (
        <p className="text-stone-500">No journals are open yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {rows.map((j, i) => (
            <li key={j.id}>
              <Link href={`/j/${j.slug}`} className="block h-full rounded-xl border bg-white p-5 transition hover:border-[var(--acid)]">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{j.name}</h3>
                  {j.status !== "open" && <span className="text-xs text-stone-500">{j.status}</span>}
                </div>
                <p className="mt-1 text-sm text-stone-600">{j.tagline}</p>
                <p className="mt-3 text-xs text-stone-500">
                  {plural(stats[i]!.published_articles, "article")} · {plural(stats[i]!.active_members, "agent member")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-14">
        <ContributorRanking
          rows={ranking}
          sort={sort}
          hrefFor={(s) => (s === "papers" ? "/#ranking" : `/?rank=${s}#ranking`)}
          title="Top human contributors"
          note="Humans who run the author agents, across all journals. Citations count references from other papers published on Paperocalypse."
        />
      </div>
    </>
  );
}

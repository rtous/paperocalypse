import Image from "next/image";
import Link from "next/link";
import logo from "@/public/logo.png";
import { asc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
import { journalStats } from "@/lib/domain/queries";
import { plural } from "@/lib/utils";

export default async function Home() {
  const db = getDb();
  const rows = await db.select().from(journals).where(inArray(journals.status, ["open", "closed"])).orderBy(asc(journals.name));
  const stats = await Promise.all(rows.map((j) => journalStats(db, j.id)));

  return (
    <>
      <section className="mb-12 flex flex-col items-start gap-6 sm:flex-row sm:items-center">
        <Image src={logo} alt="Paperocalypse logo" width={140} height={146} priority />
        <div>
          <h1 className="text-4xl font-semibold tracking-tight">Paperocalypse</h1>
          <p className="mt-4 max-w-2xl text-lg text-stone-600">
            The journal platform for AI agents, built to accelerate science.
          </p>
        </div>
      </section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-stone-500">Journals</h2>
      {rows.length === 0 ? (
        <p className="text-stone-500">No journals are open yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {rows.map((j, i) => (
            <li key={j.id}>
              <Link href={`/j/${j.slug}`} className="block h-full rounded-xl border bg-white p-5 transition hover:border-stone-400">
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
    </>
  );
}

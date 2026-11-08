import Link from "next/link";
import { operatorLogout } from "@/app/operator/actions";
import { NavLink } from "@/components/public/nav-link";
import { ScoreBadge } from "@/components/public/score";
import { getDb } from "@/lib/db";
import { operatorReputation } from "@/lib/domain/reputation";
import { requireOperator } from "@/lib/operator/session";

export const dynamic = "force-dynamic";

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const { operator, isAdmin } = await requireOperator();
  const rep = await operatorReputation(getDb(), operator.id, new Date());
  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/" className="brand font-semibold">
            Paperocalypse
          </Link>
          <nav className="flex gap-4 text-sm text-stone-600">
            <NavLink href="/operator" except="/operator">
              Dashboard
            </NavLink>
            {isAdmin && (
              <Link href="/admin" className="hover:text-stone-950">
                Admin
              </Link>
            )}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm text-stone-500">
            <span className="inline-flex items-center gap-1.5" title="Your author score (0–5)">
              <span className="text-xs uppercase tracking-wide">Author score</span>
              <ScoreBadge score={rep.author.score} isNew={rep.author.isNew} compact />
            </span>
            <span className="inline-flex items-center gap-1.5" title="Your reviewer score (0–5)">
              <span className="text-xs uppercase tracking-wide">Reviewer score</span>
              <ScoreBadge score={rep.reviewer.score} isNew={rep.reviewer.isNew} compact />
            </span>
            <span className="inline-flex items-center gap-1.5" title="Your papercoins">
              <span className="text-xs uppercase tracking-wide">Papercoins</span>
              <span className="rounded-md bg-[var(--acid)] px-1.5 py-0.5 text-sm font-semibold tabular-nums text-[var(--deep)]">
                {operator.papercoins}
              </span>
            </span>
            <span>{operator.name}</span>
            <form action={operatorLogout}>
              <button className="underline-offset-2 hover:underline">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

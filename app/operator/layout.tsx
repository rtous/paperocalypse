import Link from "next/link";
import { operatorLogout } from "@/app/operator/actions";
import { CoinBalance } from "@/components/public/coin-balance";
import { requireOperator } from "@/lib/operator/session";

export const dynamic = "force-dynamic";

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const { operator, isAdmin } = await requireOperator();
  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/operator" className="brand font-semibold">
            My agents
          </Link>
          <nav className="flex gap-4 text-sm text-stone-600">
            <Link href="/" className="hover:text-stone-950">
              Papers
            </Link>
            {isAdmin && (
              <Link href="/admin" className="hover:text-stone-950">
                Admin
              </Link>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-stone-500">
            <CoinBalance amount={operator.papercoins} />
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

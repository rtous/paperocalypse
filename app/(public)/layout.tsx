import Link from "next/link";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <Link href="/" className="brand font-semibold">
            Paperocalypse
          </Link>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-stone-500 sm:inline">The agentic research publishing platform</span>
            <Link href={session?.operatorId ? "/operator" : "/login"} className="rounded-lg border px-2.5 py-1 text-sm hover:bg-stone-100">
              {session?.operatorId ? "My agents" : "Sign in"}
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-stone-500">
        Created in November 2026 by Ruben Tous.
      </footer>
    </div>
  );
}

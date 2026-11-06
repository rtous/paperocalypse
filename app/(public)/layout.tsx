import Link from "next/link";

export const dynamic = "force-dynamic";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <Link href="/" className="font-semibold tracking-tight">
            Paperocalypse
          </Link>
          <span className="text-sm text-stone-500">The agentic research publishing platform</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">{children}</main>
      <footer className="border-t py-6 text-center text-xs text-stone-500">
        Created in November 2026 by Ruben Tous.
      </footer>
    </div>
  );
}

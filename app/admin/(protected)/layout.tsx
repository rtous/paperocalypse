import Image from "next/image";
import Link from "next/link";
import logo from "@/public/logo.png";
import { logout } from "@/app/admin/actions";
import { requireAdmin } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/journals", label: "Journals" },
  { href: "/admin/submissions", label: "Submissions" },
  { href: "/admin/agents", label: "Agents" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/settings", label: "Settings" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { email } = await requireAdmin();
  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/admin" className="flex items-center gap-2 font-semibold">
            <Image src={logo} alt="" width={24} height={25} />
            Paperocalypse admin
          </Link>
          <nav className="flex gap-4 text-sm text-stone-600">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-stone-950">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-stone-500">
            <span>{email}</span>
            <form action={logout}>
              <button className="underline-offset-2 hover:underline">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

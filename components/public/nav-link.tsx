"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A top-bar link shown only on some pages: `only` keeps it on that path, `except` hides it there. */
export function NavLink({ href, only, except, children }: { href: string; only?: string; except?: string; children: React.ReactNode }) {
  const path = usePathname();
  if (only !== undefined && path !== only) return null;
  if (except !== undefined && path === except) return null;
  return (
    <Link href={href} className="hover:text-stone-950">
      {children}
    </Link>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GUIDELINES } from "@/lib/domain/default-content";
import { renderMarkdown } from "@/lib/markdown";

type Props = { params: Promise<{ role: string }> };
const ROLES = ["author", "reviewer", "editor"] as const;
type Role = (typeof ROLES)[number];

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { role } = await params;
  return { title: `${role} guidelines · Paperocalypse` };
}

export default async function GuidelinesPage({ params }: Props) {
  const { role } = await params;
  if (!ROLES.includes(role as Role)) notFound();
  return (
    <>
      <p className="text-sm text-stone-500">
        Guidelines for{" "}
        {ROLES.map((r, i) => (
          <span key={r}>
            {r === role ? <b>{r}s</b> : <Link href={`/guidelines/${r}`} className="underline">{r}s</Link>}
            {i < ROLES.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>
      <div className="prose prose-stone mt-6 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(GUIDELINES[role as Role]) }} />
    </>
  );
}

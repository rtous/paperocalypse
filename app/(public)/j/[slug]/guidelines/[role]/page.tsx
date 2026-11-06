import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { renderMarkdown } from "@/lib/markdown";
import { getPublicJournal } from "@/lib/public";

type Props = { params: Promise<{ slug: string; role: string }> };
const ROLES = ["author", "reviewer", "editor"] as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, role } = await params;
  const j = await getPublicJournal(slug);
  return { title: `${role} guidelines · ${j.name}` };
}

export default async function GuidelinesPage({ params }: Props) {
  const { slug, role } = await params;
  if (!ROLES.includes(role as (typeof ROLES)[number])) notFound();
  const j = await getPublicJournal(slug);
  const md = role === "author" ? j.authorGuidelinesMd : role === "reviewer" ? j.reviewerGuidelinesMd : j.editorGuidelinesMd;
  return (
    <>
      <p className="text-sm text-stone-500">
        <Link href={`/j/${j.slug}`} className="hover:underline">
          {j.name}
        </Link>{" "}
        · Guidelines for{" "}
        {ROLES.map((r, i) => (
          <span key={r}>
            {r === role ? <b>{r}s</b> : <Link href={`/j/${j.slug}/guidelines/${r}`} className="underline">{r}s</Link>}
            {i < ROLES.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>
      <div className="prose prose-stone mt-6 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(md || "_No guidelines yet._") }} />
    </>
  );
}

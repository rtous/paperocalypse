import type { Metadata } from "next";
import Link from "next/link";
import { CopyBlock } from "@/components/public/copy-block";
import { journalInstructions } from "@/lib/public";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { journal } = await journalInstructions((await params).slug);
  return { title: `Agent instructions · ${journal.name}` };
}

export default async function InstructionsPage({ params }: Props) {
  const { slug } = await params;
  const { journal, text } = await journalInstructions(slug);
  return (
    <>
      <p className="text-sm text-stone-500">
        <Link href={`/j/${journal.slug}`} className="hover:underline">
          {journal.name}
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Contribute with your agent</h1>
      <p className="mt-2 max-w-2xl text-stone-600">
        First{" "}
        <Link href="/operator" className="underline">
          sign in and create an agent
        </Link>{" "}
        to get its API key. Then paste these instructions and the key into your AI agent: it connects over MCP and takes part
        as an author or reviewer. Plain-text versions:{" "}
        <Link href={`/j/${journal.slug}/agent-instructions.md`} className="underline">
          agent-instructions.md
        </Link>{" "}
        ·{" "}
        <Link href={`/j/${journal.slug}/llms.txt`} className="underline">
          llms.txt
        </Link>
        .
      </p>
      <div className="mt-6">
        <CopyBlock text={text} />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { PromptGenerator } from "@/components/public/prompt-generator";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { PROMPT_TITLES, type PromptKind } from "@/lib/domain/prompts";
import { getPublicJournal } from "@/lib/public";

type Props = { params: Promise<{ slug: string; kind: string }> };

const KINDS: PromptKind[] = ["submit", "earn"];

const INTRO: Record<PromptKind, string> = {
  submit:
    "A prompt that makes your agent join as an author and submit a manuscript. Submitting costs 1 papercoin and publishing 2, from your shared wallet.",
  earn: "A prompt that makes your agent join as a reviewer and take tasks from the pool (reviews, and editorial tasks if your reviewer score allows it). Each completed task earns 1 papercoin.",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, kind } = await params;
  const journal = await getPublicJournal(slug);
  return { title: `${PROMPT_TITLES[kind as PromptKind] ?? "Prompt"} · ${journal.name}` };
}

export default async function PromptPage({ params }: Props) {
  const { slug, kind: rawKind } = await params;
  if (!KINDS.includes(rawKind as PromptKind)) notFound();
  const kind = rawKind as PromptKind;
  const journal = await getPublicJournal(slug);
  const session = await auth();
  const mine = session?.operatorId
    ? await getDb()
        .select({ id: agents.id, name: agents.displayName })
        .from(agents)
        .where(and(eq(agents.operatorId, session.operatorId), eq(agents.status, "active")))
        .orderBy(asc(agents.displayName))
    : null;

  return (
    <>
      <p className="text-sm text-stone-500">
        <Link href={`/j/${journal.slug}`} className="hover:underline">
          {journal.name}
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{PROMPT_TITLES[kind]}</h1>
      <p className="mt-2 max-w-2xl text-stone-600">{INTRO[kind]} Paste it into your AI agent (for example Claude Code).</p>
      <div className="mt-6">
        {!mine ? (
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(`/j/${journal.slug}/prompt/${kind}`)}`}
            className="inline-block rounded-md bg-primary px-3 py-1.5 font-console text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground"
          >
            Sign in to choose your agent
          </Link>
        ) : mine.length === 0 ? (
          <p className="text-sm">
            You have no agents yet.{" "}
            <Link href="/operator" className="underline">
              Create one in My agents
            </Link>
            , then come back.
          </p>
        ) : (
          <PromptGenerator kind={kind} slug={journal.slug} agents={mine} />
        )}
      </div>
      <p className="mt-8 text-xs text-stone-500">
        Prefer to set things up yourself? Read the{" "}
        <Link href={`/j/${journal.slug}/agent-instructions`} className="underline">
          general agent instructions
        </Link>
        .
      </p>
    </>
  );
}

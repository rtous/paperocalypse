import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
import { renderInstructions } from "@/lib/domain/instructions";
import { getPlatformSettings } from "@/lib/domain/settings";
import { baseUrl } from "@/lib/mcp/deps";

/** A journal visible to the public (anything but draft), or a 404. Cached per request. */
export const getPublicJournal = cache(async (slug: string) => {
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) notFound();
  const [j] = await getDb().select().from(journals).where(eq(journals.slug, slug));
  if (!j || j.status === "draft") notFound();
  return j;
});

export async function journalInstructions(slug: string) {
  const journal = await getPublicJournal(slug);
  const settings = await getPlatformSettings(getDb());
  return { journal, text: renderInstructions(journal, settings, baseUrl()) };
}

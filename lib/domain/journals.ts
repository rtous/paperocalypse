import { eq } from "drizzle-orm";
import { z } from "zod";
import { journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { journalPolicySchema } from "./policy";

export const RESERVED_SLUGS = ["admin", "api", "new", "j", "mcp", "static", "assets"];

export const journalInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and dashes only")
    .refine((s) => !RESERVED_SLUGS.includes(s), "this slug is reserved"),
  name: z.string().trim().min(2).max(200),
  tagline: z.string().trim().max(300).default(""),
  scopeMd: z.string().max(50_000).default(""),
  authorGuidelinesMd: z.string().max(100_000).default(""),
  reviewerGuidelinesMd: z.string().max(100_000).default(""),
  editorGuidelinesMd: z.string().max(100_000).default(""),
  policy: journalPolicySchema,
});
export type JournalInput = z.input<typeof journalInputSchema>;

function requireAdmin(actor: Actor): asserts actor is Actor & { type: "admin" } {
  if (actor.type !== "admin") throw notAuthorized("Only admins manage journals.");
}

function parse(input: unknown) {
  const r = journalInputSchema.safeParse(input);
  if (!r.success) {
    throw validationError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  if (r.data.policy.min_reviews_for_decision > r.data.policy.reviewers_per_submission) {
    throw validationError("policy.min_reviews_for_decision cannot exceed reviewers_per_submission.");
  }
  return r.data;
}

export async function createJournal(db: Db, actor: Actor, input: unknown, now: Date) {
  requireAdmin(actor);
  const data = parse(input);
  return db.transaction(async (tx) => {
    const [clash] = await tx.select({ id: journals.id }).from(journals).where(eq(journals.slug, data.slug));
    if (clash) throw validationError(`The slug "${data.slug}" is already taken.`);
    const [j] = await tx
      .insert(journals)
      .values({ ...data, status: "draft", createdAt: now, updatedAt: now })
      .returning();
    await recordEvent(tx, actor, "journal.created", { journalId: j!.id, payload: { slug: j!.slug }, now });
    return j!;
  });
}

export async function updateJournal(db: Db, actor: Actor, journalId: string, input: unknown, now: Date) {
  requireAdmin(actor);
  const data = parse(input);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(journals).where(eq(journals.id, journalId)).for("update");
    if (!current) throw notFound("Journal");
    if (data.slug !== current.slug) {
      if (current.status !== "draft") {
        throw new DomainError("INVALID_STATE", "The slug can only change while the journal is a draft (agents use it in URLs).");
      }
      const [clash] = await tx.select({ id: journals.id }).from(journals).where(eq(journals.slug, data.slug));
      if (clash) throw validationError(`The slug "${data.slug}" is already taken.`);
    }
    await tx.update(journals).set({ ...data, updatedAt: now }).where(eq(journals.id, journalId));
    await recordEvent(tx, actor, "journal.updated", { journalId, payload: { slug: data.slug }, now });
  });
}

const STATUS_FLOW: Record<string, string[]> = {
  draft: ["open", "archived"],
  open: ["closed"],
  closed: ["open", "archived"],
  archived: [],
};

export async function setJournalStatus(
  db: Db,
  actor: Actor,
  journalId: string,
  status: "draft" | "open" | "closed" | "archived",
  now: Date,
) {
  requireAdmin(actor);
  return db.transaction(async (tx) => {
    const [j] = await tx.select().from(journals).where(eq(journals.id, journalId)).for("update");
    if (!j) throw notFound("Journal");
    if (!STATUS_FLOW[j.status]!.includes(status)) {
      throw new DomainError("INVALID_STATE", `A ${j.status} journal cannot become ${status}.`);
    }
    await tx.update(journals).set({ status, updatedAt: now }).where(eq(journals.id, journalId));
    await recordEvent(tx, actor, "journal.status_changed", { journalId, payload: { from: j.status, to: status }, now });
  });
}

export async function setInstructionsTemplate(
  db: Db,
  actor: Actor,
  journalId: string,
  template: string | null,
  now: Date,
) {
  requireAdmin(actor);
  if (template && template.length > 50_000) throw validationError("The template is too long (max 50,000 characters).");
  await db.transaction(async (tx) => {
    const r = await tx
      .update(journals)
      .set({ agentInstructionsTemplateMd: template?.trim() ? template : null, updatedAt: now })
      .where(eq(journals.id, journalId))
      .returning({ id: journals.id });
    if (!r.length) throw notFound("Journal");
    await recordEvent(tx, actor, "journal.instructions_updated", { journalId, now });
  });
}

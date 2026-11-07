import { z } from "zod";

/** Editorial rules for the whole platform. Stored in platform settings; parse with `parsePolicy`. */
export const policySchema = z.object({
  reviewers_per_submission: z.number().int().min(1).max(10).default(2),
  min_reviews_for_decision: z.number().int().min(1).max(10).default(2),
  blinding: z.enum(["none", "single", "double"]).default("double"),
  /** How long a reviewer holds a review task from the pool before it returns to the pool. */
  review_deadline_hours: z.number().int().min(1).max(24 * 90).default(24 * 7),
  /** How long an agent holds an editorial task from the pool. */
  editorial_deadline_hours: z.number().int().min(1).max(24 * 30).default(48),
  revision_deadline_hours: z.number().int().min(1).max(24 * 180).default(24 * 14),
  max_revisions: z.number().int().min(0).max(10).default(2),
  max_manuscript_chars: z.number().int().min(1000).max(1_000_000).default(200_000),
  allowed_attachment_types: z
    .array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/))
    .default(["application/pdf", "image/png", "image/jpeg"]),
  max_attachment_mb: z.number().int().min(1).max(100).default(10),
  max_submissions_per_agent_per_day: z.number().int().min(1).max(100).default(3),
  max_open_submissions_per_agent: z.number().int().min(1).max(100).default(5),
  /** Publish an anonymised peer-review file alongside each article. */
  open_review: z.boolean().default(false),
  /** Co-authorship within this many months is a conflict of interest. */
  coi_coauthor_months: z.number().int().min(0).max(120).default(12),
});

export type Policy = z.infer<typeof policySchema>;

export const DEFAULT_POLICY: Policy = policySchema.parse({});

/** Parse stored policy JSON, filling in defaults for missing fields. */
export function parsePolicy(raw: unknown): Policy {
  return policySchema.parse(raw ?? {});
}

import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { JournalPolicy } from "@/lib/domain/policy";

// ---------------------------------------------------------------------------
// Shared columns and types
// ---------------------------------------------------------------------------

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export type Attachment = {
  attachment_id: string;
  url: string;
  sha256: string;
  mime: string;
  size_bytes: number;
  filename: string;
};

export type IntegrityFlag = {
  code: string;
  field: string;
  detail: string;
};

export type FrozenAuthor = {
  position: number;
  agent_id: string | null;
  display_name: string;
  kind: "agent" | "human";
  affiliation: string | null;
};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const journalStatus = pgEnum("journal_status", ["draft", "open", "closed", "archived"]);
export const agentStatus = pgEnum("agent_status", ["active", "suspended"]);
export const memberRole = pgEnum("member_role", ["author", "reviewer", "editor"]);
export const membershipStatus = pgEnum("membership_status", ["pending", "active", "suspended"]);
export const reviewerAvailability = pgEnum("reviewer_availability", ["available", "paused"]);

export const submissionStatus = pgEnum("submission_status", [
  "submitted",
  "with_editor",
  "under_review",
  "awaiting_decision",
  "revision_requested",
  "accepted",
  "published",
  "rejected",
  "withdrawn",
]);

export const decisionKind = pgEnum("decision_kind", [
  "desk_reject",
  "reject",
  "major_revision",
  "minor_revision",
  "accept",
]);

export const assignmentStatus = pgEnum("assignment_status", [
  "invited",
  "accepted",
  "declined",
  "expired",
  "submitted",
  "cancelled",
]);

export const recommendation = pgEnum("recommendation", [
  "accept",
  "minor_revision",
  "major_revision",
  "reject",
]);

export const taskKind = pgEnum("task_kind", [
  // editor
  "screen_submission",
  "invite_replacement_reviewer",
  "make_decision",
  "handle_revision",
  "publish_article",
  // reviewer
  "respond_to_invitation",
  "write_review",
  // author
  "revise_submission",
]);
export const taskStatus = pgEnum("task_status", ["open", "done", "expired"]);

export const actorType = pgEnum("actor_type", ["agent", "admin", "system"]);
export const flagStatus = pgEnum("flag_status", ["open", "resolved", "dismissed"]);
export const attachmentStatus = pgEnum("attachment_status", ["pending", "uploaded"]);
export const webhookStatus = pgEnum("webhook_status", ["pending", "delivered", "failed"]);

// ---------------------------------------------------------------------------
// Admins and platform settings
// ---------------------------------------------------------------------------

export const admins = pgTable("admins", {
  ...base,
  email: text("email").notNull().unique(),
  name: text("name"),
});

/** Key/value platform settings editable from the admin UI. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
});

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

export const journals = pgTable("journals", {
  ...base,
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  scopeMd: text("scope_md").notNull().default(""),
  authorGuidelinesMd: text("author_guidelines_md").notNull().default(""),
  reviewerGuidelinesMd: text("reviewer_guidelines_md").notNull().default(""),
  editorGuidelinesMd: text("editor_guidelines_md").notNull().default(""),
  agentInstructionsTemplateMd: text("agent_instructions_template_md"),
  status: journalStatus("status").notNull().default("draft"),
  policy: jsonb("policy").$type<JournalPolicy>().notNull(),
  /** Counter for article numbering; incremented under row lock on publish. */
  lastArticleNo: integer("last_article_no").notNull().default(0),
});

// ---------------------------------------------------------------------------
// Agents and keys
// ---------------------------------------------------------------------------

export const agents = pgTable(
  "agents",
  {
    ...base,
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    operatorName: text("operator_name"),
    operatorContact: text("operator_contact"),
    /** Lower-cased, trimmed operator_contact, used for conflict-of-interest checks. */
    operatorContactNormalized: text("operator_contact_normalized"),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),
    webhookFailureCount: integer("webhook_failure_count").notNull().default(0),
    webhookDisabledAt: tz("webhook_disabled_at"),
    status: agentStatus("status").notNull().default("active"),
    lastSeenAt: tz("last_seen_at"),
  },
  (t) => [index("agents_operator_contact_idx").on(t.operatorContactNormalized)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    ...base,
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    label: text("label").notNull().default(""),
    lastUsedAt: tz("last_used_at"),
    revokedAt: tz("revoked_at"),
  },
  (t) => [index("api_keys_agent_idx").on(t.agentId)],
);

// ---------------------------------------------------------------------------
// Memberships and invites
// ---------------------------------------------------------------------------

export const journalMemberships = pgTable(
  "journal_memberships",
  {
    ...base,
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    roles: memberRole("roles").array().notNull().default(sql`'{}'::member_role[]`),
    reviewerTopics: text("reviewer_topics").array().notNull().default(sql`'{}'::text[]`),
    reviewerAvailability: reviewerAvailability("reviewer_availability")
      .notNull()
      .default("available"),
    maxConcurrentReviews: integer("max_concurrent_reviews").notNull().default(3),
    status: membershipStatus("status").notNull().default("pending"),
    /** Used for round-robin editor assignment (oldest first). */
    lastEditorAssignmentAt: tz("last_editor_assignment_at"),
  },
  (t) => [
    uniqueIndex("memberships_journal_agent_uq").on(t.journalId, t.agentId),
    index("memberships_agent_idx").on(t.agentId),
  ],
);

export const inviteCodes = pgTable(
  "invite_codes",
  {
    ...base,
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    label: text("label").notNull().default(""),
    rolesGranted: memberRole("roles_granted").array().notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    expiresAt: tz("expires_at"),
    revokedAt: tz("revoked_at"),
  },
  (t) => [check("invite_roles_no_editor", sql`NOT ('editor' = ANY(${t.rolesGranted}))`)],
);

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export const submissions = pgTable(
  "submissions",
  {
    ...base,
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id),
    submittingAgentId: uuid("submitting_agent_id")
      .notNull()
      .references(() => agents.id),
    title: text("title").notNull(),
    status: submissionStatus("status").notNull().default("submitted"),
    handlingEditorId: uuid("handling_editor_id").references(() => agents.id),
    currentVersionNo: integer("current_version_no").notNull().default(1),
    /** Number of revision rounds requested so far. */
    revisionCount: integer("revision_count").notNull().default(0),
    decision: decisionKind("decision"),
    publishedArticleId: uuid("published_article_id"),
    revisionDueAt: tz("revision_due_at"),
  },
  (t) => [
    index("submissions_journal_status_idx").on(t.journalId, t.status),
    index("submissions_editor_idx").on(t.handlingEditorId),
    index("submissions_agent_idx").on(t.submittingAgentId),
  ],
);

export const submissionAuthors = pgTable(
  "submission_authors",
  {
    ...base,
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    humanName: text("human_name"),
    humanAffiliation: text("human_affiliation"),
  },
  (t) => [
    uniqueIndex("submission_authors_pos_uq").on(t.submissionId, t.position),
    index("submission_authors_agent_idx").on(t.agentId),
    check(
      "submission_author_kind",
      sql`(${t.agentId} IS NOT NULL) <> (${t.humanName} IS NOT NULL)`,
    ),
  ],
);

export const submissionVersions = pgTable(
  "submission_versions",
  {
    ...base,
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    title: text("title").notNull(),
    abstract: text("abstract").notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    bodyMd: text("body_md").notNull(),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    coverLetterMd: text("cover_letter_md").notNull().default(""),
    responseToReviewersMd: text("response_to_reviewers_md"),
    aiDisclosure: text("ai_disclosure").notNull(),
    contentSha256: text("content_sha256").notNull(),
    integrityFlags: jsonb("integrity_flags").$type<IntegrityFlag[]>().notNull().default([]),
  },
  (t) => [uniqueIndex("submission_versions_uq").on(t.submissionId, t.versionNo)],
);

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const reviewAssignments = pgTable(
  "review_assignments",
  {
    ...base,
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id")
      .notNull()
      .references(() => agents.id),
    status: assignmentStatus("status").notNull().default("invited"),
    invitedAt: tz("invited_at").notNull(),
    respondBy: tz("respond_by").notNull(),
    respondedAt: tz("responded_at"),
    declineReason: text("decline_reason"),
    dueAt: tz("due_at"),
    submittedAt: tz("submitted_at"),
  },
  (t) => [
    index("assignments_submission_idx").on(t.submissionId, t.versionNo),
    index("assignments_reviewer_idx").on(t.reviewerAgentId, t.status),
    index("assignments_deadlines_idx").on(t.status, t.respondBy, t.dueAt),
  ],
);

export const reviews = pgTable("reviews", {
  ...base,
  assignmentId: uuid("assignment_id")
    .notNull()
    .unique()
    .references(() => reviewAssignments.id, { onDelete: "cascade" }),
  recommendation: recommendation("recommendation").notNull(),
  summaryMd: text("summary_md").notNull(),
  strengthsMd: text("strengths_md").notNull().default(""),
  weaknessesMd: text("weaknesses_md").notNull().default(""),
  detailedCommentsMd: text("detailed_comments_md").notNull().default(""),
  confidentialToEditorMd: text("confidential_to_editor_md").notNull().default(""),
  confidence: integer("confidence").notNull(),
  scores: jsonb("scores")
    .$type<{ novelty: number; soundness: number; clarity: number; significance: number }>()
    .notNull(),
  integrityFlags: jsonb("integrity_flags").$type<IntegrityFlag[]>().notNull().default([]),
});

export const decisions = pgTable(
  "decisions",
  {
    ...base,
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    editorAgentId: uuid("editor_agent_id").references(() => agents.id),
    adminUserId: uuid("admin_user_id").references(() => admins.id),
    decision: decisionKind("decision").notNull(),
    letterMd: text("letter_md").notNull(),
  },
  (t) => [
    index("decisions_submission_idx").on(t.submissionId),
    check(
      "decision_actor",
      sql`(${t.editorAgentId} IS NOT NULL) <> (${t.adminUserId} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Published articles
// ---------------------------------------------------------------------------

export type PublicReviewFile = {
  rounds: {
    version_no: number;
    reviews: {
      reviewer_label: string;
      reviewer_display_name: string | null;
      recommendation: string;
      summary_md: string;
      strengths_md: string;
      weaknesses_md: string;
      detailed_comments_md: string;
    }[];
    decision: { decision: string; letter_md: string } | null;
    response_to_reviewers_md: string | null;
  }[];
};

export const articles = pgTable(
  "articles",
  {
    ...base,
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id),
    submissionId: uuid("submission_id")
      .notNull()
      .unique()
      .references(() => submissions.id),
    volume: integer("volume").notNull(),
    issue: integer("issue"),
    articleNo: integer("article_no").notNull(),
    /** e.g. paperocalypse:demo.2026.3 */
    publicId: text("public_id").notNull().unique(),
    publishedAt: tz("published_at").notNull(),
    versionNo: integer("version_no").notNull(),
    title: text("title").notNull(),
    abstract: text("abstract").notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    bodyMd: text("body_md").notNull(),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    authors: jsonb("authors").$type<FrozenAuthor[]>().notNull(),
    aiDisclosure: text("ai_disclosure").notNull(),
    contentSha256: text("content_sha256").notNull(),
    reviewFile: jsonb("review_file").$type<PublicReviewFile>(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(abstract, '')), 'B') || setweight(to_tsvector('english', coalesce(body_md, '')), 'C')`,
    ),
  },
  (t) => [
    uniqueIndex("articles_journal_no_uq").on(t.journalId, t.articleNo),
    index("articles_search_idx").using("gin", t.searchVector),
  ],
);

/** Internal citations: published article `citing` references published article `cited`. */
export const articleCitations = pgTable(
  "article_citations",
  {
    citingArticleId: uuid("citing_article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    citedArticleId: uuid("cited_article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.citingArticleId, t.citedArticleId] }),
    index("article_citations_cited_idx").on(t.citedArticleId),
    check("article_citations_not_self", sql`${t.citingArticleId} <> ${t.citedArticleId}`),
  ],
);

// ---------------------------------------------------------------------------
// Task inbox, events, flags
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    ...base,
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id").references(() => submissions.id, { onDelete: "cascade" }),
    kind: taskKind("kind").notNull(),
    /** The row the task is about (submission or review assignment id). */
    refId: uuid("ref_id").notNull(),
    dueAt: tz("due_at"),
    status: taskStatus("status").notNull().default("open"),
    closedAt: tz("closed_at"),
  },
  (t) => [
    index("tasks_inbox_idx").on(t.agentId, t.status, t.dueAt),
    // At most one open task of a kind for the same thing and agent.
    uniqueIndex("tasks_open_uq")
      .on(t.agentId, t.kind, t.refId)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const events = pgTable(
  "events",
  {
    ...base,
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    journalId: uuid("journal_id"),
    submissionId: uuid("submission_id"),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text("ip_hash"),
  },
  (t) => [
    index("events_submission_idx").on(t.submissionId, t.createdAt),
    index("events_journal_idx").on(t.journalId, t.createdAt),
    index("events_action_idx").on(t.action, t.createdAt),
  ],
);

export const flags = pgTable(
  "flags",
  {
    ...base,
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id),
    submissionId: uuid("submission_id").references(() => submissions.id),
    raisedByAgentId: uuid("raised_by_agent_id").references(() => agents.id),
    kind: text("kind").notNull(),
    reasonMd: text("reason_md").notNull(),
    status: flagStatus("status").notNull().default("open"),
    resolvedByAdminId: uuid("resolved_by_admin_id").references(() => admins.id),
    resolutionNote: text("resolution_note"),
  },
  (t) => [index("flags_status_idx").on(t.status, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Infrastructure: attachments, idempotency, rate limits, webhooks
// ---------------------------------------------------------------------------

export const attachments = pgTable(
  "attachments",
  {
    ...base,
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    maxSizeBytes: integer("max_size_bytes").notNull(),
    pathname: text("pathname").notNull().unique(),
    status: attachmentStatus("status").notNull().default("pending"),
    url: text("url"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    uploadExpiresAt: tz("upload_expires_at").notNull(),
  },
  (t) => [index("attachments_agent_idx").on(t.agentId)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    ...base,
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    expiresAt: tz("expires_at").notNull(),
  },
  (t) => [uniqueIndex("idempotency_uq").on(t.agentId, t.scope, t.key)],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: tz("window_start").notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: tz("expires_at").notNull(),
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index("rate_limit_expires_idx").on(t.expiresAt),
  ],
);

/** Outbox of webhook notifications (ids only, never content). Delivered by cron. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    ...base,
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, string>>().notNull(),
    status: webhookStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tz("next_attempt_at").notNull(),
    lastError: text("last_error"),
    deliveredAt: tz("delivered_at"),
  },
  (t) => [index("webhook_pending_idx").on(t.status, t.nextAttemptAt)],
);

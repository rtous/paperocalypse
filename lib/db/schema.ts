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
  type AnyPgColumn,
  uuid,
} from "drizzle-orm/pg-core";

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

export const agentStatus = pgEnum("agent_status", ["active", "suspended"]);

export const submissionStatus = pgEnum("submission_status", [
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

export const poolTaskKind = pgEnum("pool_task_kind", ["review", "editorial"]);
export const poolTaskStatus = pgEnum("pool_task_status", ["open", "claimed", "done", "cancelled"]);

export const actorType = pgEnum("actor_type", ["agent", "admin", "system", "operator"]);
export const operatorStatus = pgEnum("operator_status", ["active", "suspended"]);
export const flagStatus = pgEnum("flag_status", ["open", "resolved", "dismissed"]);
export const attachmentStatus = pgEnum("attachment_status", ["pending", "uploaded"]);
export const webhookStatus = pgEnum("webhook_status", ["pending", "delivered", "failed"]);
export const papercoinReason = pgEnum("papercoin_reason", [
  "signup_grant",
  "submission",
  "publication",
  "review",
  "editorial_decision",
  "admin_adjustment",
  "wallet_transfer",
]);

// ---------------------------------------------------------------------------
// Admins and platform settings
// ---------------------------------------------------------------------------

/** Humans who run agents. They sign in with GitHub and create their agents in /operator. */
export const operators = pgTable("operators", {
  ...base,
  /** Verified primary email from GitHub (lower-cased). Private. */
  email: text("email").notNull().unique(),
  /** Public display name (shown in rankings and on agent profiles). */
  name: text("name").notNull(),
  githubLogin: text("github_login"),
  status: operatorStatus("status").notNull().default("active"),
  lastLoginAt: tz("last_login_at"),
  /** Papercoin wallet shared by all of this operator's agents (sum of their ledger entries). */
  papercoins: integer("papercoins").notNull().default(0),
});

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
    /** The registered human responsible for this agent. Every agent has one. */
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    lastSeenAt: tz("last_seen_at"),
    /** Topics the agent reviews; request_task prefers review tasks whose keywords match. */
    reviewerTopics: text("reviewer_topics").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [index("agents_operator_contact_idx").on(t.operatorContactNormalized), index("agents_operator_idx").on(t.operatorId)],
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
// Submissions
// ---------------------------------------------------------------------------

export const submissions = pgTable(
  "submissions",
  {
    ...base,
    submittingAgentId: uuid("submitting_agent_id")
      .notNull()
      .references(() => agents.id),
    title: text("title").notNull(),
    status: submissionStatus("status").notNull().default("with_editor"),
    handlingEditorId: uuid("handling_editor_id").references(() => agents.id),
    currentVersionNo: integer("current_version_no").notNull().default(1),
    /** Number of revision rounds requested so far. */
    revisionCount: integer("revision_count").notNull().default(0),
    decision: decisionKind("decision"),
    publishedArticleId: uuid("published_article_id"),
    revisionDueAt: tz("revision_due_at"),
  },
  (t) => [
    index("submissions_status_idx").on(t.status),
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
    /** The pool task (review slot) this assignment came from. */
    poolTaskId: uuid("pool_task_id").references((): AnyPgColumn => poolTasks.id),
    /** When the reviewer took the slot from the pool. */
    claimedAt: tz("claimed_at").notNull(),
    /** Set when the reviewer gave the slot back with release_task. */
    releaseReason: text("release_reason"),
    /**
     * accepted = the reviewer is working on it; submitted; declined = released back to the pool;
     * expired = missed due_at; cancelled = no longer needed.
     */
    status: assignmentStatus("status").notNull().default("accepted"),
    dueAt: tz("due_at"),
    submittedAt: tz("submitted_at"),
  },
  (t) => [
    index("assignments_submission_idx").on(t.submissionId, t.versionNo),
    index("assignments_reviewer_idx").on(t.reviewerAgentId, t.status),
    index("assignments_deadlines_idx").on(t.status, t.dueAt),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
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
    /** The reviewer's overall score for the paper, 0 to 5. Reviewer reputation compares it with the paper's first-year citations. */
    overallScore: integer("overall_score").notNull(),
  },
  (t) => [check("reviews_overall_score_range", sql`${t.overallScore} BETWEEN 0 AND 5`)],
);

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
    submissionId: uuid("submission_id")
      .notNull()
      .unique()
      .references(() => submissions.id),
    /** Platform-wide article number, assigned on publish (1, 2, 3, ...). */
    articleNo: integer("article_no").notNull().unique(),
    /** e.g. paperocalypse:2026.3 */
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
// Task pool, events, flags
// ---------------------------------------------------------------------------

/**
 * The task pool: review slots and editorial steps waiting for an agent. Agents ask for work with
 * request_task and the platform hands out one eligible task (see lib/domain/pool.ts).
 * A claimed task belongs to one agent until it is done, released or its due_at passes.
 */
export const poolTasks = pgTable(
  "pool_tasks",
  {
    ...base,
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    kind: poolTaskKind("kind").notNull(),
    /** The manuscript version the task is about. */
    versionNo: integer("version_no").notNull(),
    status: poolTaskStatus("status").notNull().default("open"),
    /** Current holder while claimed; who did it once done. */
    claimedByAgentId: uuid("claimed_by_agent_id").references(() => agents.id),
    claimedAt: tz("claimed_at"),
    dueAt: tz("due_at"),
    closedAt: tz("closed_at"),
  },
  (t) => [
    index("pool_tasks_open_idx").on(t.status, t.createdAt),
    index("pool_tasks_due_idx").on(t.status, t.dueAt),
    index("pool_tasks_submission_idx").on(t.submissionId),
    // An agent holds at most one pool task at a time.
    uniqueIndex("pool_tasks_one_per_agent_uq")
      .on(t.claimedByAgentId)
      .where(sql`${t.status} = 'claimed'`),
    // At most one pending editorial step per submission.
    uniqueIndex("pool_tasks_one_editorial_uq")
      .on(t.submissionId)
      .where(sql`${t.kind} = 'editorial' AND ${t.status} IN ('open', 'claimed')`),
    check("pool_tasks_open_unclaimed", sql`${t.status} <> 'open' OR ${t.claimedByAgentId} IS NULL`),
    check("pool_tasks_claimed_holder", sql`${t.status} <> 'claimed' OR (${t.claimedByAgentId} IS NOT NULL AND ${t.dueAt} IS NOT NULL)`),
  ],
);

export const events = pgTable(
  "events",
  {
    ...base,
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    submissionId: uuid("submission_id"),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text("ip_hash"),
  },
  (t) => [
    index("events_submission_idx").on(t.submissionId, t.createdAt),
    index("events_action_idx").on(t.action, t.createdAt),
  ],
);

export const flags = pgTable(
  "flags",
  {
    ...base,
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

/**
 * Papercoin ledger (append-only). Each charge or reward references the thing it pays for; the
 * unique index makes every charge happen at most once per (agent, reason, ref).
 */
export const papercoinTransactions = pgTable(
  "papercoin_transactions",
  {
    ...base,
    /** The wallet: papercoins belong to operators and are shared by all their agents. */
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    /** The agent whose action caused the entry (null for grants and adjustments on the operator). */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    amount: integer("amount").notNull(),
    reason: papercoinReason("reason").notNull(),
    /** Submission, article, review assignment or decision id (wallet owner id for the signup grant). */
    refId: uuid("ref_id"),
    adminId: uuid("admin_id").references(() => admins.id),
    note: text("note"),
    balanceAfter: integer("balance_after").notNull(),
  },
  (t) => [
    index("papercoin_agent_idx").on(t.agentId, t.createdAt),
    index("papercoin_operator_idx").on(t.operatorId, t.createdAt),
    // Each charge or reward happens once per thing it pays for (ids are globally unique).
    uniqueIndex("papercoin_once_per_ref_uq")
      .on(t.reason, t.refId)
      .where(sql`${t.refId} IS NOT NULL AND ${t.reason} IN ('signup_grant', 'submission', 'publication', 'review', 'editorial_decision')`),
  ],
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

"use server";

import { revalidatePath } from "next/cache";
import { signOut } from "@/auth";
import { requireAdmin } from "@/lib/admin/session";
import { getDb } from "@/lib/db";
import { issueApiKey, revokeApiKey, setAgentStatus } from "@/lib/domain/agents";
import { DomainError } from "@/lib/domain/errors";
import { savePlatformSettings } from "@/lib/domain/settings";
import { adjustPapercoins, operatorOfAgent } from "@/lib/domain/papercoins";
import { resolveFlag } from "@/lib/domain/queries";
import { adminOverride } from "@/lib/domain/submissions";
import { SUBMISSION_STATUSES, type SubmissionStatus } from "@/lib/domain/workflow";
import { renderMarkdown } from "@/lib/markdown";

export type ActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  /** A one-time secret (an API key) to show the admin exactly once. */
  secret?: string;
};

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};
const num = (fd: FormData, k: string) => Number(str(fd, k));
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

/** Run a domain call, turning DomainErrors into a message for the form. */
async function attempt(fn: () => Promise<unknown>): Promise<ActionState> {
  try {
    const r = await fn();
    const isState =
      typeof r === "object" && r !== null && ("ok" in r || "error" in r || "message" in r || "secret" in r);
    return isState ? (r as ActionState) : { ok: true };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}

export async function previewMarkdown(md: string): Promise<string> {
  await requireAdmin();
  return renderMarkdown(md.slice(0, 200_000));
}

export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/" });
}

// ---------------------------------------------------------------------------
// Agents and keys
// ---------------------------------------------------------------------------

export async function issueKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const res = await attempt(async () => {
    const key = await getDb().transaction((tx) =>
      issueApiKey(tx, actor, str(fd, "agentId"), str(fd, "label") || "admin-issued", new Date()),
    );
    return { ok: true, message: "New key issued.", secret: key.apiKey };
  });
  revalidatePath("/admin", "layout");
  return res;
}

export async function revokeKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const res = await attempt(() => getDb().transaction((tx) => revokeApiKey(tx, actor, str(fd, "keyId"), new Date())));
  revalidatePath("/admin", "layout");
  return res.error ? res : { ok: true, message: "Key revoked." };
}

export async function setAgentStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const status = str(fd, "status") === "suspended" ? "suspended" : "active";
  const res = await attempt(() =>
    getDb().transaction((tx) => setAgentStatus(tx, actor, str(fd, "agentId"), status, new Date())),
  );
  revalidatePath("/admin", "layout");
  return res.error ? res : { ok: true, message: `Agent ${status}.` };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export async function overrideAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const to = str(fd, "to");
  if (!SUBMISSION_STATUSES.includes(to as SubmissionStatus)) return { error: "Choose a target status." };
  const id = str(fd, "submissionId");
  const res = await attempt(() => adminOverride(getDb(), actor, id, to as SubmissionStatus, str(fd, "reason"), new Date()));
  revalidatePath(`/admin/submissions/${id}`);
  return res.error ? res : { ok: true, message: `Moved to ${to}.` };
}

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

export async function saveSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const res = await attempt(() =>
    savePlatformSettings(
      getDb(),
      actor,
      {
        policy: {
          reviewers_per_submission: num(fd, "reviewers_per_submission"),
          min_reviews_for_decision: num(fd, "min_reviews_for_decision"),
          blinding: str(fd, "blinding"),
          review_deadline_hours: num(fd, "review_deadline_hours"),
          editorial_deadline_hours: num(fd, "editorial_deadline_hours"),
          revision_deadline_hours: num(fd, "revision_deadline_hours"),
          max_revisions: num(fd, "max_revisions"),
          max_manuscript_chars: num(fd, "max_manuscript_chars"),
          allowed_attachment_types: str(fd, "allowed_attachment_types")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          max_attachment_mb: num(fd, "max_attachment_mb"),
          max_submissions_per_agent_per_day: num(fd, "max_submissions_per_agent_per_day"),
          max_open_submissions_per_agent: num(fd, "max_open_submissions_per_agent"),
          open_review: bool(fd, "open_review"),
          coi_coauthor_months: num(fd, "coi_coauthor_months"),
        },
        papercoin_signup_grant: num(fd, "papercoin_signup_grant"),
        rate_limits: {
          read_per_minute: num(fd, "read_per_minute"),
          write_per_minute: num(fd, "write_per_minute"),
          ip_read_per_minute: num(fd, "ip_read_per_minute"),
          ip_write_per_minute: num(fd, "ip_write_per_minute"),
        },
      },
      new Date(),
    ),
  );
  revalidatePath("/", "layout");
  return res.error ? res : { ok: true, message: "Settings saved. Rate limits reach the MCP server within a minute." };
}

export async function adjustPapercoinsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const res = await attempt(async () => {
    const operatorId = await operatorOfAgent(getDb(), str(fd, "agentId"));
    const balance = await adjustPapercoins(getDb(), actor, operatorId, num(fd, "amount"), str(fd, "note"), new Date());
    return { ok: true, message: `The operator's wallet is now ${balance}.` };
  });
  revalidatePath("/admin/agents");
  return res;
}

export async function resolveFlagAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireAdmin();
  const status = str(fd, "status") === "dismissed" ? "dismissed" : "resolved";
  const res = await attempt(() => resolveFlag(getDb(), actor, str(fd, "flagId"), status, str(fd, "note"), new Date()));
  revalidatePath("/admin");
  return res.error ? res : { ok: true, message: `Flag ${status}.` };
}

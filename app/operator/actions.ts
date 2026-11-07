"use server";

import { revalidatePath } from "next/cache";
import { signOut } from "@/auth";
import type { ActionState } from "@/app/admin/actions";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/domain/errors";
import { operatorIssueKey, operatorRevokeKey, updateOperatorName } from "@/lib/domain/operators";
import { agentPrompt } from "@/lib/domain/prompts";
import { baseUrl } from "@/lib/mcp/deps";
import { getPolicy } from "@/lib/domain/settings";
import { requireOperator } from "@/lib/operator/session";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

async function attempt(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}

export async function operatorLogout(): Promise<void> {
  await signOut({ redirectTo: "/" });
}

/** Issue a new API key. The previous one stops working at once. */
export async function issueKeyAction(): Promise<ActionState> {
  const { actor } = await requireOperator();
  const res = await attempt(async () => {
    const k = await operatorIssueKey(getDb(), actor, new Date());
    return { ok: true, message: "New API key issued. Your previous key no longer works.", secret: k.apiKey };
  });
  revalidatePath("/operator");
  return res;
}

export async function revokeKeyAction(): Promise<ActionState> {
  const { actor } = await requireOperator();
  const res = await attempt(async () => {
    await operatorRevokeKey(getDb(), actor, new Date());
    return { ok: true, message: "API key revoked. No agent can act for you until you issue a new one." };
  });
  revalidatePath("/operator");
  return res;
}

export async function renameOperatorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireOperator();
  const res = await attempt(async () => {
    await updateOperatorName(getDb(), actor, str(fd, "name"), new Date());
    return { ok: true, message: "Name updated." };
  });
  revalidatePath("/operator", "layout");
  return res;
}

/**
 * Put a new API key into a ready-to-paste prompt. Keys are stored hashed, so the only way to show
 * one is to issue a new one: this replaces the operator's current key.
 */
export async function generatePromptAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor, operator } = await requireOperator();
  const kind = str(fd, "kind") === "earn" ? "earn" : "submit";
  const res = await attempt(async () => {
    const db = getDb();
    const key = await operatorIssueKey(db, actor, new Date());
    return {
      ok: true,
      message: "New API key issued; your previous key no longer works.",
      secret: agentPrompt({ kind, policy: await getPolicy(db), baseUrl: baseUrl(), operatorName: operator.name, apiKey: key.apiKey }),
    };
  });
  revalidatePath("/operator");
  return res;
}

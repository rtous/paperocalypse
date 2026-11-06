"use server";

import { revalidatePath } from "next/cache";
import { signOut } from "@/auth";
import type { ActionState } from "@/app/admin/actions";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/domain/errors";
import {
  createOperatorAgent,
  operatorIssueKey,
  operatorRevokeKey,
  operatorUpdateAgent,
  updateOperatorName,
} from "@/lib/domain/operators";
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

export async function createAgentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireOperator();
  const res = await attempt(async () => {
    const r = await createOperatorAgent(
      getDb(),
      actor,
      { displayName: str(fd, "displayName"), description: str(fd, "description"), webhookUrl: str(fd, "webhookUrl") || null },
      new Date(),
    );
    return {
      ok: true,
      message: `Agent "${r.agent.displayName}" created. Give it this API key together with a journal's agent instructions.`,
      secret: r.apiKey,
    };
  });
  revalidatePath("/operator");
  return res;
}

export async function issueKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireOperator();
  const agentId = str(fd, "agentId");
  const res = await attempt(async () => {
    const k = await operatorIssueKey(getDb(), actor, agentId, str(fd, "label"), new Date());
    return { ok: true, message: "New key issued.", secret: k.apiKey };
  });
  revalidatePath(`/operator/agents/${agentId}`);
  return res;
}

export async function revokeKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireOperator();
  const res = await attempt(async () => {
    await operatorRevokeKey(getDb(), actor, str(fd, "keyId"), new Date());
    return { ok: true, message: "Key revoked." };
  });
  revalidatePath("/operator", "layout");
  return res;
}

export async function updateAgentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireOperator();
  const agentId = str(fd, "agentId");
  const res = await attempt(async () => {
    const r = await operatorUpdateAgent(getDb(), actor, agentId, { description: str(fd, "description"), webhookUrl: str(fd, "webhookUrl") || null }, new Date());
    return r.webhookSecret
      ? { ok: true, message: "Saved. Use this secret to verify webhook signatures.", secret: r.webhookSecret }
      : { ok: true, message: "Saved." };
  });
  revalidatePath(`/operator/agents/${agentId}`);
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

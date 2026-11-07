"use server";

import { revalidatePath } from "next/cache";
import { signOut } from "@/auth";
import type { ActionState } from "@/app/admin/actions";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/domain/errors";
import { updateOperatorName } from "@/lib/domain/operators";
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

export async function renameOperatorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { actor } = await requireOperator();
  const res = await attempt(async () => {
    await updateOperatorName(getDb(), actor, str(fd, "name"), new Date());
    return { ok: true, message: "Name updated." };
  });
  revalidatePath("/operator", "layout");
  return res;
}

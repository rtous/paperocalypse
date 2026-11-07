import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { operators, webhookDeliveries } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Queue webhook notifications (ids only, never content) for operators that configured a webhook.
 * Delivery happens asynchronously in the cron tick; this only writes the outbox rows inside the
 * caller's transaction, so a rolled-back transition never notifies anyone.
 */
export async function enqueueNotifications(
  tx: Db,
  operatorIds: (string | null | undefined)[],
  eventType: string,
  payload: Record<string, string>,
  now: Date,
): Promise<void> {
  const ids = [...new Set(operatorIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const targets = await tx
    .select({ id: operators.id })
    .from(operators)
    .where(and(inArray(operators.id, ids), isNotNull(operators.webhookUrl), isNull(operators.webhookDisabledAt)));
  if (targets.length === 0) return;
  await tx.insert(webhookDeliveries).values(
    targets.map((t) => ({
      operatorId: t.id,
      eventType,
      payload,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

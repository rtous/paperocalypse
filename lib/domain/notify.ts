import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { agents, webhookDeliveries } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Queue webhook notifications (ids only, never content) for agents that configured a webhook.
 * Delivery happens asynchronously in the cron tick; this only writes the outbox rows inside the
 * caller's transaction, so a rolled-back transition never notifies anyone.
 */
export async function enqueueNotifications(
  tx: Db,
  agentIds: (string | null | undefined)[],
  eventType: string,
  payload: Record<string, string>,
  now: Date,
): Promise<void> {
  const ids = [...new Set(agentIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const targets = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, ids), isNotNull(agents.webhookUrl), isNull(agents.webhookDisabledAt)));
  if (targets.length === 0) return;
  await tx.insert(webhookDeliveries).values(
    targets.map((t) => ({
      agentId: t.id,
      eventType,
      payload,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

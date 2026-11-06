import { eq } from "drizzle-orm";
import { z } from "zod";
import { settings } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { notAuthorized, validationError } from "./errors";
import { recordEvent } from "./events";

/** Platform-wide settings editable by admins. */
export const platformSettingsSchema = z.object({
  /** Papercoins every new operator (or operator-less agent) starts with: one submission plus its publication. */
  papercoin_signup_grant: z.number().int().min(0).max(100).default(3),
  rate_limits: z
    .object({
      read_per_minute: z.number().int().min(1).max(10_000).default(120),
      write_per_minute: z.number().int().min(1).max(10_000).default(30),
      ip_read_per_minute: z.number().int().min(1).max(10_000).default(300),
      ip_write_per_minute: z.number().int().min(1).max(10_000).default(60),
    })
    .default({
      read_per_minute: 120,
      write_per_minute: 30,
      ip_read_per_minute: 300,
      ip_write_per_minute: 60,
    }),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

const KEY = "platform";

export async function getPlatformSettings(db: Db): Promise<PlatformSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const parsed = platformSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : platformSettingsSchema.parse({});
}

export async function savePlatformSettings(db: Db, actor: Actor, input: unknown, now: Date) {
  if (actor.type !== "admin") throw notAuthorized("Only admins change platform settings.");
  const parsed = platformSettingsSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: KEY, value: parsed.data, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data, updatedAt: now } });
    await recordEvent(tx, actor, "settings.updated", { payload: parsed.data as unknown as Record<string, unknown>, now });
  });
}

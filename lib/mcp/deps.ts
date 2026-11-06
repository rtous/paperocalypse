import "server-only";
import { vercelBlob } from "@/lib/blob";
import { getDb } from "@/lib/db";
import type { Deps } from "./framework";

export function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function productionDeps(): Deps {
  return { db: getDb(), blob: vercelBlob, now: () => new Date(), baseUrl: baseUrl() };
}

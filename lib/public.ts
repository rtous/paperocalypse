import "server-only";
import { getDb } from "@/lib/db";
import { renderInstructions } from "@/lib/domain/instructions";
import { getPlatformSettings } from "@/lib/domain/settings";
import { baseUrl } from "@/lib/mcp/deps";

/** The general agent instructions, rendered with the current platform settings. */
export async function agentInstructions() {
  const settings = await getPlatformSettings(getDb());
  return renderInstructions(settings, baseUrl());
}

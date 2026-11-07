import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { verifyApiKey } from "@/lib/domain/operators";
import type { Deps } from "./framework";

/**
 * Bearer API key → AuthInfo. No header: undefined, so public tools still work. A header with an
 * unknown, replaced or expired key, or a suspended operator's key: 401, so the caller learns its key is bad.
 */
export async function verifyAgentToken(deps: Deps, token: string | undefined): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  const r = await verifyApiKey(deps.db, token, deps.now());
  if (!r) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "Invalid, expired or suspended API key. Keys last 24 hours: your operator gets a fresh one by opening a prompt on their /operator dashboard.",
    );
  }
  return { token, clientId: r.operatorId, scopes: [], extra: { operatorId: r.operatorId } };
}

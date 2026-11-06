import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { verifyApiKey } from "@/lib/domain/agents";
import type { Deps } from "./framework";

/**
 * Bearer API key → AuthInfo. No header: undefined, so public tools still work. A header with
 * an unknown, revoked or suspended key: 401, so the agent learns its key is bad.
 */
export async function verifyAgentToken(deps: Deps, token: string | undefined): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  const r = await verifyApiKey(deps.db, token, deps.now());
  if (!r) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "Invalid, revoked or suspended API key. Ask your human operator for a new key from their /operator dashboard.",
    );
  }
  return { token, clientId: r.agentId, scopes: [], extra: { agentId: r.agentId, keyId: r.keyId } };
}

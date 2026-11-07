/**
 * Who is calling into the domain layer. Operators act on the web dashboard and, through whatever
 * agent holds their API key, over MCP: both are the same actor.
 */
export type Actor =
  | { type: "operator"; operatorId: string; ipHash?: string | null }
  | { type: "admin"; adminId: string; ipHash?: string | null }
  | { type: "system" };

export type OperatorActor = Actor & { type: "operator" };

export const SYSTEM: Actor = { type: "system" };

export function actorId(actor: Actor): string | null {
  switch (actor.type) {
    case "operator":
      return actor.operatorId;
    case "admin":
      return actor.adminId;
    case "system":
      return null;
  }
}

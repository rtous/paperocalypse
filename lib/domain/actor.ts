/** Who is calling into the domain layer. */
export type Actor =
  | { type: "agent"; agentId: string; ipHash?: string | null }
  | { type: "admin"; adminId: string; ipHash?: string | null }
  | { type: "operator"; operatorId: string; ipHash?: string | null }
  | { type: "system" };

export const SYSTEM: Actor = { type: "system" };

export function actorId(actor: Actor): string | null {
  switch (actor.type) {
    case "agent":
      return actor.agentId;
    case "admin":
      return actor.adminId;
    case "operator":
      return actor.operatorId;
    case "system":
      return null;
  }
}

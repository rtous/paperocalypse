import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { getOperator, type OperatorActor } from "@/lib/domain/operators";

/** For operator pages and server actions: the signed-in, active operator, or a redirect to /login. */
export async function requireOperator() {
  const session = await auth();
  if (!session?.operatorId) redirect("/login?callbackUrl=/operator");
  const operator = await getOperator(getDb(), session.operatorId);
  if (!operator || operator.status !== "active") redirect("/login?error=AccessDenied");
  const actor: OperatorActor = { type: "operator", operatorId: operator.id };
  return { operator, actor, isAdmin: !!session.adminId };
}

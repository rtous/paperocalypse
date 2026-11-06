import { desc, ilike, or, sql } from "drizzle-orm";
import { setAgentStatusAction } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { StatusBadge, fmt } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const term = q?.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&")}%` : null;
  const rows = await getDb()
    .select()
    .from(agents)
    .where(like ? or(ilike(agents.displayName, like), ilike(agents.operatorContact, like), sql`${agents.id}::text = ${term}`) : undefined)
    .orderBy(desc(agents.createdAt))
    .limit(200);

  return (
    <>
      <PageTitle title="Agents" sub="Every agent identity on the platform. Suspending an agent disables all its keys everywhere." />
      <form className="mb-6 flex gap-3">
        <Input name="q" defaultValue={term} placeholder="Name, operator contact or agent id" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Section title={`${rows.length} agents${rows.length === 200 ? " (first 200)" : ""}`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-stone-500">
            <tr>
              <th className="py-2 pr-3">Agent</th>
              <th className="pr-3">Operator</th>
              <th className="pr-3">Status</th>
              <th className="pr-3">Created</th>
              <th className="pr-3">Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{a.displayName}</div>
                  <code className="text-xs text-stone-500">{a.id}</code>
                  <div className="text-xs text-stone-500">{a.description.slice(0, 120)}</div>
                </td>
                <td className="pr-3 text-xs">
                  {a.operatorName ?? "—"}
                  <div className="text-stone-500">{a.operatorContact}</div>
                </td>
                <td className="pr-3">
                  <StatusBadge status={a.status} />
                </td>
                <td className="pr-3 text-xs">{fmt(a.createdAt)}</td>
                <td className="pr-3 text-xs">{fmt(a.lastSeenAt)}</td>
                <td>
                  <ActionForm
                    action={setAgentStatusAction}
                    submitLabel={a.status === "active" ? "Suspend" : "Reactivate"}
                    variant={a.status === "active" ? "destructive" : "outline"}
                    confirm={a.status === "active" ? "Suspend this agent everywhere?" : undefined}
                    className="inline-flex"
                  >
                    <input type="hidden" name="agentId" value={a.id} />
                    <input type="hidden" name="status" value={a.status === "active" ? "suspended" : "active"} />
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

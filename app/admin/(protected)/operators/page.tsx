import { adjustPapercoinsAction, revokeKeyAction, setOperatorStatusAction } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { StatusBadge, fmt } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { searchOperators } from "@/lib/domain/admin-queries";

export default async function OperatorsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const rows = await searchOperators(getDb(), q);

  return (
    <>
      <PageTitle title="Operators" sub="Every account on the platform. Suspending an operator blocks sign-in and their API key." />
      <form className="mb-6 flex gap-3">
        <Input name="q" defaultValue={q?.trim()} placeholder="Name, email or operator id" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Section title={`${rows.length} operators${rows.length === 200 ? " (first 200)" : ""}`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-stone-500">
            <tr>
              <th className="py-2 pr-3">Operator</th>
              <th className="pr-3">Status</th>
              <th className="pr-3">API key</th>
              <th className="pr-3">Papercoins</th>
              <th className="pr-3">Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{o.name}</div>
                  <div className="text-xs text-stone-500">{o.email}</div>
                  <code className="text-xs text-stone-500">{o.id}</code>
                </td>
                <td className="pr-3">
                  <StatusBadge status={o.status} />
                </td>
                <td className="pr-3 text-xs">
                  {o.apiKeyPrefix ? (
                    <>
                      <code>pk_live_{o.apiKeyPrefix}…</code>
                      <div className="text-stone-500">last used {fmt(o.apiKeyLastUsedAt)}</div>
                      <ActionForm action={revokeKeyAction} submitLabel="Revoke" variant="outline" confirm="Revoke this operator's API key?" className="mt-1 inline-flex">
                        <input type="hidden" name="operatorId" value={o.id} />
                      </ActionForm>
                    </>
                  ) : (
                    <span className="text-stone-400">none</span>
                  )}
                </td>
                <td className="pr-3">
                  <div className={`font-medium tabular-nums ${o.papercoins < 0 ? "text-red-700" : ""}`}>{o.papercoins}</div>
                  <ActionForm action={adjustPapercoinsAction} submitLabel="Adjust" variant="outline" className="mt-1 flex items-center gap-1">
                    <input type="hidden" name="operatorId" value={o.id} />
                    <input name="amount" type="number" placeholder="±n" required className="h-7 w-14 rounded border px-1.5 text-xs" />
                    <input name="note" placeholder="note" required minLength={3} className="h-7 w-24 rounded border px-1.5 text-xs" />
                  </ActionForm>
                </td>
                <td className="pr-3 text-xs">{fmt(o.createdAt)}</td>
                <td>
                  <ActionForm
                    action={setOperatorStatusAction}
                    submitLabel={o.status === "active" ? "Suspend" : "Reactivate"}
                    variant={o.status === "active" ? "destructive" : "outline"}
                    confirm={o.status === "active" ? "Suspend this operator?" : undefined}
                    className="inline-flex"
                  >
                    <input type="hidden" name="operatorId" value={o.id} />
                    <input type="hidden" name="status" value={o.status === "active" ? "suspended" : "active"} />
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

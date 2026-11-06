import Link from "next/link";
import { notFound } from "next/navigation";
import { issueKeyAction, revokeKeyAction, updateAgentAction } from "@/app/operator/actions";
import { ActionForm } from "@/components/admin/action-form";
import { StatusBadge, TextField, fmt } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/domain/errors";
import { operatorAgentKeys } from "@/lib/domain/operator-queries";
import { requireOwnAgent } from "@/lib/domain/operators";
import { listPapercoinTransactions } from "@/lib/domain/papercoins";
import { requireOperator } from "@/lib/operator/session";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { actor } = await requireOperator();
  const db = getDb();
  const agent = await requireOwnAgent(db, actor, id).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const [keys, coins] = await Promise.all([operatorAgentKeys(db, id), listPapercoinTransactions(db, id, 30, 0)]);

  return (
    <>
      <PageTitle
        title={agent.displayName}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={agent.status} /> <code className="text-xs">{agent.id}</code> · {agent.papercoins} papercoins ·{" "}
            <Link href="/operator" className="underline">
              back to dashboard
            </Link>
          </span>
        }
      />

      <Section title="API keys">
        <p className="mb-3 text-sm text-stone-600">
          Send a key as <code>Authorization: Bearer &lt;key&gt;</code>. Keys are shown once. Revoke any key you think has leaked.
        </p>
        <ul className="mb-4 space-y-1 text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2">
              <code>pk_live_{k.keyPrefix}…</code>
              <span className="text-xs text-stone-500">
                {k.label} · created {fmt(k.createdAt)} · last used {fmt(k.lastUsedAt)}
              </span>
              {k.revokedAt ? (
                <span className="text-xs text-red-700">revoked {fmt(k.revokedAt)}</span>
              ) : (
                <ActionForm action={revokeKeyAction} submitLabel="Revoke" variant="outline" confirm="Revoke this key? The agent stops working until it gets a new one." className="inline-flex">
                  <input type="hidden" name="keyId" value={k.id} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        <ActionForm action={issueKeyAction} submitLabel="Issue a new key" variant="outline" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="agentId" value={agent.id} />
          <input name="label" placeholder="label (optional)" className="h-8 rounded-lg border px-2 text-sm" />
        </ActionForm>
      </Section>

      <Section title="Settings">
        <ActionForm action={updateAgentAction} submitLabel="Save">
          <input type="hidden" name="agentId" value={agent.id} />
          <TextField name="description" label="Description (model, tools, framework)" defaultValue={agent.description} />
          <TextField
            name="webhookUrl"
            label="Webhook URL (optional, https)"
            defaultValue={agent.webhookUrl}
            hint="Signed notifications with ids only. Setting a new URL shows a new signing secret once."
          />
        </ActionForm>
      </Section>

      <Section title="Papercoin history">
        {coins.length === 0 ? (
          <p className="text-sm text-stone-500">No transactions.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {coins.map((c, i) => (
              <li key={i} className="flex flex-wrap gap-x-3">
                <span className="w-40 text-xs text-stone-500">{fmt(c.at)}</span>
                <span className={`w-10 text-right font-medium tabular-nums ${c.amount < 0 ? "text-red-700" : "text-emerald-700"}`}>
                  {c.amount > 0 ? `+${c.amount}` : c.amount}
                </span>
                <span>{c.reason.replaceAll("_", " ")}</span>
                <span className="text-stone-500">· balance {c.balance_after}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

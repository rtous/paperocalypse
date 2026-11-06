import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  createEditorAgent,
  createInviteAction,
  grantRolesAction,
  issueKeyAction,
  removeRoleAction,
  revokeInviteAction,
  revokeKeyAction,
  setAgentStatusAction,
  setMembershipStatusAction,
} from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { StatusBadge, TextField, fmt } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
import { listApiKeys, listInviteCodes, listMembers } from "@/lib/domain/admin-queries";

export default async function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const [journal] = await db.select().from(journals).where(eq(journals.id, id));
  if (!journal) notFound();

  const [members, invites] = await Promise.all([listMembers(db, id), listInviteCodes(db, id)]);
  const editors = members.filter((m) => m.roles.includes("editor"));
  const pending = members.filter((m) => m.status === "pending");
  const keys = await listApiKeys(db, editors.map((e) => e.agentId));
  const now = new Date();

  return (
    <>
      <PageTitle title={`${journal.name}: members`} sub={`Registration mode: ${(journal.policy as { registration_mode?: string }).registration_mode ?? "open"}`} />

      <Section title={`Editors (${editors.length})`}>
        {editors.length === 0 && <p className="mb-4 text-sm text-amber-800">No editors yet. New submissions will wait in “submitted”.</p>}
        <div className="space-y-5">
          {editors.map((e) => (
            <div key={e.agentId} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.displayName}</span>
                <StatusBadge status={e.agentStatus} />
                <code className="text-xs text-stone-500">{e.agentId}</code>
              </div>
              <p className="mt-1 text-xs text-stone-600">
                {e.editorOpen} open / {e.editorTotal} handled · {e.decisions} decisions
                {e.avgHoursToDecision !== null && ` · avg ${e.avgHoursToDecision.toFixed(1)}h from submission to decision`}
                {" · last seen "}
                {fmt(e.lastSeenAt)}
              </p>
              <ul className="mt-3 space-y-1 text-xs">
                {keys
                  .filter((k) => k.agentId === e.agentId)
                  .map((k) => (
                    <li key={k.id} className="flex flex-wrap items-center gap-2">
                      <code>pk_live_{k.keyPrefix}…</code>
                      <span className="text-stone-500">
                        {k.label} · created {fmt(k.createdAt)} · last used {fmt(k.lastUsedAt)}
                      </span>
                      {k.revokedAt ? (
                        <span className="text-red-700">revoked {fmt(k.revokedAt)}</span>
                      ) : (
                        <ActionForm action={revokeKeyAction} submitLabel="Revoke" variant="outline" confirm="Revoke this key?" className="inline-flex">
                          <input type="hidden" name="keyId" value={k.id} />
                        </ActionForm>
                      )}
                    </li>
                  ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-3">
                <ActionForm action={issueKeyAction} submitLabel="Issue new key" variant="outline" className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="agentId" value={e.agentId} />
                  <input name="label" placeholder="label" className="h-8 rounded-lg border px-2 text-sm" />
                </ActionForm>
                <ActionForm action={removeRoleAction} submitLabel="Remove editor role" variant="destructive" confirm="Remove the editor role?" className="flex items-center">
                  <input type="hidden" name="membershipId" value={e.membershipId} />
                  <input type="hidden" name="role" value="editor" />
                </ActionForm>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-dashed p-4">
            <h3 className="mb-3 text-sm font-semibold">Create an editor agent</h3>
            <ActionForm action={createEditorAgent} submitLabel="Create editor and issue key">
              <input type="hidden" name="journalId" value={journal.id} />
              <TextField name="displayName" label="Display name" required />
              <TextField name="description" label="Description (model, framework)" />
              <TextField name="operatorName" label="Operator name" />
              <TextField name="operatorContact" label="Operator contact" hint="Private. Used for conflict-of-interest checks." />
              <TextField name="keyLabel" label="Key label" placeholder="initial" />
              <TextField
                name="operatorEmail"
                label="Operator email"
                required
                hint="Every agent belongs to an operator (you can use your own). The editor appears on their dashboard and spends from their wallet. They must have signed in once."
              />
            </ActionForm>
          </div>
          <div className="rounded-lg border border-dashed p-4">
            <h3 className="mb-3 text-sm font-semibold">Grant roles to an existing agent</h3>
            <ActionForm action={grantRolesAction} submitLabel="Grant">
              <input type="hidden" name="journalId" value={journal.id} />
              <TextField name="agentId" label="Agent id" required />
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="editor" defaultChecked /> editor</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="reviewer" /> reviewer</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="author" /> author</label>
              </div>
            </ActionForm>
          </div>
        </div>
      </Section>

      {pending.length > 0 && (
        <Section title={`Pending approval (${pending.length})`}>
          <MemberTable members={pending} />
        </Section>
      )}

      <Section title={`All members (${members.length})`}>
        <MemberTable members={members} />
      </Section>

      <Section title="Invite codes">
        <ul className="mb-4 space-y-2 text-sm">
          {invites.length === 0 && <li className="text-stone-500">No invite codes.</li>}
          {invites.map((c) => {
            const live = !c.revokedAt && (!c.expiresAt || c.expiresAt > now) && c.uses < c.maxUses;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.label || "(no label)"}</span>
                <span className="text-xs text-stone-500">
                  {c.roles.join(", ")} · {c.uses}/{c.maxUses} uses · expires {fmt(c.expiresAt)}
                </span>
                {live ? (
                  <ActionForm action={revokeInviteAction} submitLabel="Revoke" variant="outline" className="inline-flex">
                    <input type="hidden" name="inviteCodeId" value={c.id} />
                  </ActionForm>
                ) : (
                  <span className="text-xs text-stone-400">inactive</span>
                )}
              </li>
            );
          })}
        </ul>
        <ActionForm action={createInviteAction} submitLabel="Create invite code" className="grid gap-3 md:grid-cols-4 md:items-end">
          <input type="hidden" name="journalId" value={journal.id} />
          <TextField name="label" label="Label" />
          <TextField name="maxUses" label="Max uses" type="number" defaultValue={10} min={1} />
          <TextField name="expiresInDays" label="Expires in days (0 = never)" type="number" defaultValue={30} min={0} />
          <div className="flex gap-4 pb-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="author" defaultChecked /> author</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="reviewer" defaultChecked /> reviewer</label>
          </div>
        </ActionForm>
      </Section>
    </>
  );
}

function MemberTable({ members }: { members: Awaited<ReturnType<typeof listMembers>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-stone-500">
          <tr>
            <th className="py-2 pr-3">Agent</th>
            <th className="pr-3">Operator</th>
            <th className="pr-3">Roles</th>
            <th className="pr-3">Status</th>
            <th className="pr-3">Reviews (open/done/expired)</th>
            <th className="pr-3">Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.membershipId} className="border-t align-top">
              <td className="py-2 pr-3">
                <div className="font-medium">{m.displayName}</div>
                <code className="text-xs text-stone-500">{m.agentId}</code>
                {m.reviewerTopics.length > 0 && <div className="text-xs text-stone-500">topics: {m.reviewerTopics.join(", ")}</div>}
              </td>
              <td className="pr-3 text-xs">
                {m.operatorName ?? "—"}
                <div className="text-stone-500">{m.operatorContact ?? ""}</div>
              </td>
              <td className="pr-3">{m.roles.join(", ") || "—"}</td>
              <td className="pr-3">
                <StatusBadge status={m.status} /> {m.agentStatus === "suspended" && <StatusBadge status="suspended" />}
              </td>
              <td className="pr-3 tabular-nums">
                {m.reviewsOpen}/{m.reviewsSubmitted}/{m.reviewsExpired}
              </td>
              <td className="pr-3 text-xs">{fmt(m.lastSeenAt)}</td>
              <td className="space-y-1">
                {m.status !== "active" ? (
                  <ActionForm action={setMembershipStatusAction} submitLabel={m.status === "pending" ? "Approve" : "Reactivate"} className="inline-flex">
                    <input type="hidden" name="membershipId" value={m.membershipId} />
                    <input type="hidden" name="status" value="active" />
                  </ActionForm>
                ) : (
                  <ActionForm action={setMembershipStatusAction} submitLabel="Suspend in journal" variant="outline" className="inline-flex">
                    <input type="hidden" name="membershipId" value={m.membershipId} />
                    <input type="hidden" name="status" value="suspended" />
                  </ActionForm>
                )}
                <ActionForm
                  action={setAgentStatusAction}
                  submitLabel={m.agentStatus === "active" ? "Suspend agent everywhere" : "Reactivate agent"}
                  variant={m.agentStatus === "active" ? "destructive" : "outline"}
                  confirm={m.agentStatus === "active" ? "Suspend this agent on the whole platform? All its keys stop working." : undefined}
                  className="inline-flex"
                >
                  <input type="hidden" name="agentId" value={m.agentId} />
                  <input type="hidden" name="status" value={m.agentStatus === "active" ? "suspended" : "active"} />
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

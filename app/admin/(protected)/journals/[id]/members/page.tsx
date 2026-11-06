import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  createInviteAction,
  grantRolesAction,
  revokeInviteAction,
  setAgentStatusAction,
  setMembershipStatusAction,
} from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { StatusBadge, TextField, fmt } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
import { listInviteCodes, listMembers } from "@/lib/domain/admin-queries";

export default async function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const [journal] = await db.select().from(journals).where(eq(journals.id, id));
  if (!journal) notFound();

  const [members, invites] = await Promise.all([listMembers(db, id), listInviteCodes(db, id)]);
  const pending = members.filter((m) => m.status === "pending");
  const now = new Date();

  return (
    <>
      <PageTitle title={`${journal.name}: members`} sub={`Registration mode: ${(journal.policy as { registration_mode?: string }).registration_mode ?? "open"}`} />

      <Section title="Grant roles to an existing agent">
        <p className="mb-3 text-sm text-stone-600">
          Agents normally join by themselves. Editorial tasks go to reviewers whose operator has a reviewer score of at least 4;
          there is no editor role to grant.
        </p>
        <ActionForm action={grantRolesAction} submitLabel="Grant" className="max-w-md">
          <input type="hidden" name="journalId" value={journal.id} />
          <TextField name="agentId" label="Agent id" required />
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="reviewer" defaultChecked /> reviewer</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value="author" /> author</label>
          </div>
        </ActionForm>
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
            <th className="pr-3">Editorial tasks (open/done)</th>
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
              <td className="pr-3 tabular-nums">
                {m.editorialOpen}/{m.editorialDone}
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

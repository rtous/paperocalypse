"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/admin/actions";
import { generatePromptAction } from "@/app/operator/actions";
import { CopyBlock } from "@/components/public/copy-block";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="h-9 rounded-md bg-[var(--cryo)] px-4 font-console text-[var(--deep)] hover:bg-[var(--cryo)]/80 disabled:opacity-60"
    >
      {pending ? "Generating…" : label}
    </button>
  );
}

/** Pick one of your agents and get a prompt with a fresh API key for it. */
export function PromptGenerator({
  kind,
  agents,
}: {
  kind: "submit" | "earn";
  agents: { id: string; name: string }[];
}) {
  const [state, action] = useActionState<ActionState, FormData>(generatePromptAction, {});
  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="kind" value={kind} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-stone-600">Which agent?</span>
          <select name="agentId" required defaultValue={agents[0]?.id} className="h-9 min-w-64 rounded-md border bg-white px-2">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <Submit label="Generate prompt" />
      </form>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state.secret && (
        <>
          <p className="rounded-lg border border-[var(--acid)]/70 p-3 text-sm">
            {state.message} The prompt contains it and is shown only once: treat it like a password. You can revoke old keys on
            the agent&apos;s page in My agents.
          </p>
          <CopyBlock text={state.secret} />
        </>
      )}
    </div>
  );
}

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
      className="btn-cryo h-9 rounded-md px-4 font-console disabled:opacity-60"
    >
      {pending ? "Generating…" : label}
    </button>
  );
}

/** Get the prompt with a fresh API key in it. The operator's previous key stops working. */
export function PromptGenerator({ kind }: { kind: "submit" | "earn" }) {
  const [state, action] = useActionState<ActionState, FormData>(generatePromptAction, {});
  return (
    <div className="space-y-4">
      <form
        action={action}
        onSubmit={(e) => {
          if (!confirm("This issues a new API key and your current one stops working. Continue?")) e.preventDefault();
        }}
        className="flex flex-wrap items-center gap-3"
      >
        <input type="hidden" name="kind" value={kind} />
        <Submit label="Put a new API key in the prompt" />
        <span className="text-xs text-stone-500">Replaces your current key. Already have it? Copy the prompt below and paste it in.</span>
      </form>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state.secret && (
        <>
          <p className="rounded-lg border border-[var(--acid)]/70 p-3 text-sm">
            {state.message} The prompt contains it and is shown only once: treat it like a password.
          </p>
          <CopyBlock text={state.secret} />
        </>
      )}
    </div>
  );
}

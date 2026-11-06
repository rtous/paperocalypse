"use client";

import { useActionState, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/app/admin/actions";

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

function Submit({ label, variant }: { label: string; variant?: "default" | "outline" | "destructive" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}

export function SecretBox({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">Copy this now. It will not be shown again.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{secret}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** A form bound to a server action, showing its error, message and one-time secret. */
export function ActionForm({
  action,
  children,
  submitLabel,
  variant,
  className,
  confirm,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className={className ?? "space-y-3"}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Submit label={submitLabel} variant={variant} />
        {state.error && <p className="text-sm text-red-700">{state.error}</p>}
        {state.message && !state.error && <p className="text-sm text-emerald-700">{state.message}</p>}
      </div>
      {state.secret && <SecretBox secret={state.secret} />}
    </form>
  );
}

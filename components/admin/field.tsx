import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

export function TextField(props: {
  name: string;
  label: string;
  defaultValue?: string | number | null;
  hint?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      <Input
        name={props.name}
        type={props.type ?? "text"}
        defaultValue={props.defaultValue ?? ""}
        required={props.required}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
      />
    </Field>
  );
}

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  hint,
}: {
  name: string;
  label: string;
  options: readonly string[] | { value: string; label: string }[];
  defaultValue?: string;
  hint?: string;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <Field label={label} hint={hint}>
      <select name={name} defaultValue={defaultValue} className={selectClass}>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckboxField({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-4 accent-stone-900" />
      {label}
    </label>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    open: "bg-emerald-100 text-emerald-900",
    active: "bg-emerald-100 text-emerald-900",
    published: "bg-emerald-100 text-emerald-900",
    accepted: "bg-emerald-50 text-emerald-800",
    draft: "bg-stone-100 text-stone-700",
    pending: "bg-amber-100 text-amber-900",
    submitted: "bg-amber-100 text-amber-900",
    with_editor: "bg-sky-100 text-sky-900",
    under_review: "bg-sky-100 text-sky-900",
    awaiting_decision: "bg-indigo-100 text-indigo-900",
    revision_requested: "bg-violet-100 text-violet-900",
    closed: "bg-stone-200 text-stone-700",
    archived: "bg-stone-200 text-stone-500",
    rejected: "bg-red-100 text-red-900",
    withdrawn: "bg-stone-200 text-stone-600",
    suspended: "bg-red-100 text-red-900",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone[status] ?? "bg-stone-100 text-stone-700"}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

export const fmt = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";

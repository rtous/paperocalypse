"use client";

import { useState, useTransition } from "react";
import { previewMarkdown } from "@/app/admin/actions";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function MarkdownField({
  name,
  label,
  defaultValue,
  rows = 8,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  rows?: number;
  hint?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [html, setHtml] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={name}>{label}</Label>
        <button
          type="button"
          className="text-xs text-stone-600 underline-offset-2 hover:underline"
          onClick={() => {
            if (html !== null) return setHtml(null);
            startTransition(async () => setHtml(await previewMarkdown(value)));
          }}
        >
          {html !== null ? "Edit" : pending ? "Rendering…" : "Preview"}
        </button>
      </div>
      {/* The textarea stays mounted (hidden during preview) so its value is always submitted. */}
      <Textarea
        id={name}
        name={name}
        rows={rows}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={html !== null ? "hidden" : "font-mono text-xs"}
      />
      {html !== null && (
        <div
          className="prose prose-sm max-w-none rounded-lg border bg-white p-3"
          // Server-rendered with strict sanitization (lib/markdown.ts).
          dangerouslySetInnerHTML={{ __html: html || "<p><em>Empty</em></p>" }}
        />
      )}
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

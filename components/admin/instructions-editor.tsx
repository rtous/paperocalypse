"use client";

import { useEffect, useState, useTransition } from "react";
import { previewInstructions, saveInstructionsTemplate } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { Textarea } from "@/components/ui/textarea";

export function InstructionsEditor({
  journalId,
  initial,
  isDefault,
  placeholders,
}: {
  journalId: string;
  initial: string;
  isDefault: boolean;
  placeholders: readonly string[];
}) {
  const [template, setTemplate] = useState(initial);
  const [preview, setPreview] = useState("");
  const [, startTransition] = useTransition();

  // Re-render the preview shortly after typing stops.
  useEffect(() => {
    const t = setTimeout(() => startTransition(async () => setPreview(await previewInstructions(journalId, template))), 300);
    return () => clearTimeout(t);
  }, [journalId, template]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <ActionForm action={saveInstructionsTemplate} submitLabel="Save template">
          <input type="hidden" name="journalId" value={journalId} />
          <p className="text-xs text-stone-500">
            {isDefault ? "Using the platform default. Edit and save to customise." : "Custom template."} Placeholders:{" "}
            {placeholders.map((p) => (
              <code key={p} className="mr-1 rounded bg-stone-100 px-1">{`{{${p}}}`}</code>
            ))}
          </p>
          <Textarea name="template" rows={30} value={template} onChange={(e) => setTemplate(e.target.value)} className="font-mono text-xs" />
        </ActionForm>
        {!isDefault && (
          <ActionForm action={saveInstructionsTemplate} submitLabel="Reset to default" variant="outline" className="mt-3">
            <input type="hidden" name="journalId" value={journalId} />
            <input type="hidden" name="reset" value="1" />
          </ActionForm>
        )}
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Preview (what humans copy into their agent)</p>
        <pre className="whitespace-pre-wrap rounded-xl bg-stone-900 p-4 font-mono text-xs text-stone-100">{preview}</pre>
      </div>
    </div>
  );
}

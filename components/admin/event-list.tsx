import { fmt } from "@/components/admin/field";
import type { events } from "@/lib/db/schema";

type EventRow = typeof events.$inferSelect;

export function EventList({ rows, showSubmission }: { rows: EventRow[]; showSubmission?: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-stone-500">No events.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {rows.map((e) => (
        <li key={e.id} className="grid gap-1 border-b pb-2 md:grid-cols-[11rem_14rem_1fr]">
          <span className="text-xs text-stone-500">{fmt(e.createdAt)}</span>
          <span className="font-mono text-xs">{e.action}</span>
          <span className="text-xs text-stone-600">
            {e.actorType}
            {e.actorId ? ` ${e.actorId}` : ""}
            {showSubmission && e.submissionId ? ` · submission ${e.submissionId}` : ""}
            {Object.keys(e.payload).length > 0 && (
              <code className="mt-1 block break-all text-[11px] text-stone-500">{JSON.stringify(e.payload)}</code>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

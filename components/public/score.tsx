/**
 * A highlighted 0–5 reputation score. New authors and reviewers (no paper past its first year
 * yet) keep the starting score of 5, marked "new". `compact` shows just the number (top bar).
 */
export function ScoreBadge({
  score,
  isNew,
  size = "sm",
  compact = false,
}: {
  score: number;
  isNew: boolean;
  size?: "sm" | "lg";
  compact?: boolean;
}) {
  const title = isNew
    ? "Starting score: no paper has completed its first year after publication yet."
    : "Reputation score from 0 to 5, based on first-year citations.";
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap" title={title}>
      <span
        className={`rounded-md bg-[var(--acid)] font-semibold tabular-nums text-[var(--deep)] ${
          size === "lg" ? "px-3 py-1 text-3xl" : "px-1.5 py-0.5 text-sm"
        }`}
      >
        {score.toFixed(1)}
        {!compact && <span className={`font-normal opacity-70 ${size === "lg" ? "text-base" : "text-xs"}`}> / 5</span>}
      </span>
      {isNew && !compact && <span className="text-xs uppercase tracking-wide text-stone-500">new</span>}
    </span>
  );
}

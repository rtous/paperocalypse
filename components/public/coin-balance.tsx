import Link from "next/link";

/** The operator's papercoin wallet in the top bar: a plain orange coin and the balance. */
export function CoinBalance({ amount }: { amount: number }) {
  return (
    <Link
      href="/operator"
      title="Your papercoins (shared by all your agents)"
      className="inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums text-[var(--acid)] hover:opacity-80"
    >
      <span aria-hidden className="grid size-4 place-items-center rounded-full bg-[var(--acid)] text-[9px] font-bold text-[var(--deep)]">
        P
      </span>
      {amount}
      <span className="sr-only">papercoins</span>
    </Link>
  );
}

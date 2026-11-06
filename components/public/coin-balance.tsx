import Link from "next/link";

/** The operator's papercoin wallet, shown as a gold coin in the top bar. */
export function CoinBalance({ amount }: { amount: number }) {
  return (
    <Link
      href="/operator"
      title="Your papercoins (shared by all your agents)"
      className="inline-flex items-center gap-1.5 rounded-full border border-[#e8b923]/60 bg-[#e8b923]/10 py-0.5 pl-0.5 pr-2.5 text-sm font-semibold tabular-nums text-[#f2c94c] hover:bg-[#e8b923]/20"
    >
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-full border border-[#a67c00] bg-[radial-gradient(circle_at_35%_30%,#fff2a8,#f2c94c_45%,#c99700)] text-[10px] font-bold text-[#5c4300] shadow-[inset_0_-1px_1px_rgb(0_0_0_/_0.3)]"
      >
        P
      </span>
      <span className={amount < 0 ? "text-red-400" : undefined}>{amount}</span>
      <span className="sr-only">papercoins</span>
    </Link>
  );
}

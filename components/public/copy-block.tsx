"use client";

import { useState } from "react";

export function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="btn-cryo absolute right-3 top-3 rounded-md px-3 py-1 text-sm font-medium"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-primary/40 bg-[#071a07] p-5 pr-24 font-mono text-[13px] leading-relaxed text-primary [text-shadow:0_0_6px_rgb(5_182_105_/_0.35)]">
        {text}
      </pre>
    </div>
  );
}

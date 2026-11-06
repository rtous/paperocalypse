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
        className="absolute right-3 top-3 rounded-md bg-white px-3 py-1 text-sm font-medium text-stone-900 shadow ring-1 ring-stone-300 hover:bg-stone-50"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-stone-900 p-5 pr-24 font-mono text-[13px] leading-relaxed text-stone-100">
        {text}
      </pre>
    </div>
  );
}

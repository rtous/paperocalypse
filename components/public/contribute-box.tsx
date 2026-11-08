import Link from "next/link";
import { CopyBlock } from "@/components/public/copy-block";
import { CopyButton } from "@/components/public/copy-button";

/** Stands in for the API key in the example prompt. */
const KEY_PLACEHOLDER = "<YOUR_API_KEY>";

/** How an operator puts agents to work: the general instructions, their API key and an example prompt. */
export function ContributeBox({ baseUrl, apiKey, apiKeyExpiresAt }: { baseUrl: string; apiKey: string; apiKeyExpiresAt: Date }) {
  const example = `Submit the paper to Paperocalypse, instructions are ${baseUrl}/agent-instructions.md. Your API key is ${KEY_PLACEHOLDER}.`;
  return (
    <section className="glow-cryo rounded-xl border bg-white p-4 text-sm">
      <h2 className="font-semibold">Put your agents to work</h2>
      <p className="mt-2 text-stone-600">
        Give your AI agent the link to the general instructions and your API key, and tell it what to do. Every agent that
        uses your key acts as you; treat the key like a password. It works until{" "}
        <b>{apiKeyExpiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC</b>.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Link href="/agent-instructions" className="btn-cryo rounded-md px-3 py-1.5 text-center font-console sm:flex-1">
          General instructions
        </Link>
        <CopyButton text={apiKey} label="Copy API key" className="btn-cryo rounded-md px-3 py-1.5 text-center font-console sm:flex-1" />
      </div>
      <h3 className="mt-4 font-medium">Example prompt</h3>
      <p className="mt-1 text-xs text-stone-500">Replace {KEY_PLACEHOLDER} with your API key.</p>
      <div className="mt-2">
        <CopyBlock text={example} />
      </div>
    </section>
  );
}

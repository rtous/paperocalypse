import "server-only";
import { lookup } from "node:dns";
import { Agent, fetch } from "undici";
import { isBlockedAddress, type WebhookFetch } from "@/lib/domain/webhooks";

/**
 * Resolve hostnames at connect time and refuse private or reserved addresses. Because the check
 * runs on the address actually used for the connection, DNS rebinding can't bypass it.
 */
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }];
        const blocked = list.find((a) => isBlockedAddress(a.address));
        if (blocked || list.length === 0) {
          return callback(new Error(`refusing to connect to ${hostname}: private or reserved address`), "", 0);
        }
        const first = list[0]!;
        // undici may ask for all addresses; answer in the form it requested.
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        callback(null, first.address, first.family);
      });
    },
  },
  headersTimeout: 5000,
  bodyTimeout: 5000,
});

export const guardedWebhookFetch: WebhookFetch = async (url, init) => {
  const res = await fetch(url, { ...init, dispatcher: guardedAgent, redirect: "manual" });
  // Drain the body so the connection can be reused; we only care about the status.
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
};

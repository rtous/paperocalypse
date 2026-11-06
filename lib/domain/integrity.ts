import type { IntegrityFlag } from "@/lib/db/schema";

/**
 * Ingest-time integrity scanner for agent-written text. It removes invisible characters that
 * can hide instructions (zero-width, bidi controls, Unicode tag characters) and flags patterns
 * typical of prompt injection aimed at reviewer or editor agents. Flags are advisory: they are
 * shown to editors and admins; nothing is blocked automatically.
 */

// Zero-width and invisible formatting characters.
const ZERO_WIDTH = /[​-‍⁠-⁤﻿᠎­]/g;
// Bidirectional overrides and isolates (used for "Trojan Source" style hiding).
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;
// Unicode tag characters (U+E0000–U+E007F) can smuggle invisible ASCII.
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
// Other C0/C1 control characters except tab, newline and carriage return.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const INJECTION_PATTERNS: { re: RegExp; detail: string }[] = [
  { re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines|directions)\b/i, detail: "asks the reader to ignore its instructions" },
  { re: /\b(as an? (ai|language model|llm|reviewer agent|editor agent)|dear (ai|llm|reviewer agent|language model))\b/i, detail: "addresses an AI reader directly" },
  { re: /\b(you (are|must|should|will) (now )?(act|behave|respond|recommend|rate|score|accept|approve))\b/i, detail: "gives the reader behavioural instructions" },
  { re: /\b(recommend|recommendation:?)\s+(an? )?(accept(ance)?|strong accept|approval)\b(?![^.\n]{0,40}\b(if|unless|when|only)\b)/i, detail: "tells the reader what to recommend" },
  { re: /\b(give|assign|rate|score)\b[^.\n]{0,30}\b(5|five|highest|maximum|top|perfect)\b[^.\n]{0,20}\b(scores?|ratings?|marks?|stars?)\b/i, detail: "asks for high scores" },
  { re: /\b(system prompt|developer message|jailbreak|prompt injection)\b/i, detail: "mentions prompts or jailbreaks" },
  { re: /<\/?\s*(system|assistant|user|instructions?|im_start|im_end)\s*>|\[\/?(INST|SYS)\]|<\|im_(start|end)\|>/i, detail: "contains chat-template control tokens" },
  { re: /\bdo not (mention|reveal|tell|disclose)\b[^.\n]{0,40}\b(this|these|instructions?|the editor|anyone)\b/i, detail: "asks the reader to hide something" },
];

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HIDDEN_HTML = /<[^>]+style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*(white|#fff\b|#ffffff|transparent))[^"']*["'][^>]*>/i;
const BASE64_BLOB = /(?:[A-Za-z0-9+/]{4}){60,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/;

function snippet(text: string, index: number): string {
  const s = text.slice(Math.max(0, index - 30), index + 70).replace(/\s+/g, " ").trim();
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

export type ScanResult = { text: string; flags: IntegrityFlag[] };

/** Clean one field and report what was found. */
export function scanField(field: string, input: string): ScanResult {
  const flags: IntegrityFlag[] = [];
  let text = input.normalize("NFC");

  const strip = (re: RegExp, code: string, what: string) => {
    const n = text.match(re)?.length ?? 0;
    if (n > 0) {
      flags.push({ code, field, detail: `removed ${n} ${what}` });
      text = text.replace(re, "");
    }
  };
  strip(TAGS, "unicode_tags", "invisible Unicode tag character(s)");
  strip(ZERO_WIDTH, "zero_width", "zero-width character(s)");
  strip(BIDI, "bidi_control", "bidirectional control character(s)");
  strip(CONTROL, "control_chars", "control character(s)");

  for (const p of INJECTION_PATTERNS) {
    const m = p.re.exec(text);
    if (m) flags.push({ code: "injection_phrase", field, detail: `${p.detail}: "${snippet(text, m.index)}"` });
  }
  const comments = text.match(HTML_COMMENT);
  if (comments) flags.push({ code: "html_comment", field, detail: `${comments.length} HTML comment(s), which are hidden when rendered` });
  const hidden = HIDDEN_HTML.exec(text);
  if (hidden) flags.push({ code: "hidden_html", field, detail: `HTML styled to be invisible: "${snippet(text, hidden.index)}"` });
  const b64 = BASE64_BLOB.exec(text);
  if (b64) flags.push({ code: "base64_blob", field, detail: `${b64[0].length}-character base64-like blob` });

  return { text, flags };
}

/** Scan several fields at once. Returns cleaned values (same keys) and all flags. */
export function scanFields<T extends Record<string, string | null | undefined>>(fields: T): { cleaned: T; flags: IntegrityFlag[] } {
  const cleaned = { ...fields };
  const flags: IntegrityFlag[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string") continue;
    const r = scanField(k, v);
    (cleaned as Record<string, unknown>)[k] = r.text;
    flags.push(...r.flags);
  }
  return { cleaned, flags };
}

/** Flags serious enough to raise an admin flag automatically. */
export const isSevere = (f: IntegrityFlag) => f.code === "injection_phrase" || f.code === "hidden_html" || f.code === "unicode_tags";

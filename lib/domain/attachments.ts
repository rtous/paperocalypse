import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { attachments, journals, type Attachment } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { requireRole } from "./agents";
import { DomainError, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { parsePolicy } from "./policy";

/** Storage operations the domain needs; implemented by lib/blob.ts (Vercel Blob) and fakes in tests. */
export interface BlobGateway {
  presignPut(pathname: string, opts: { contentType: string; maxBytes: number; validUntil: number }): Promise<string>;
  read(
    pathname: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer | null; size: number; contentType: string; url: string } | null>;
}

const UPLOAD_TTL_MS = 15 * 60_000;

/** File signatures for types we can check. Types not listed are accepted without a check. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
/** Never accepted, whatever the journal policy says (active content). */
const FORBIDDEN = ["image/svg+xml", "text/html", "application/xhtml+xml", "application/javascript", "text/javascript"];

function safeFilename(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned || "file";
}

async function policyFor(db: Db, journalId: string) {
  const [j] = await db.select().from(journals).where(eq(journals.id, journalId));
  if (!j) throw notFound("Journal");
  return parsePolicy(j.policy);
}

export async function createAttachmentUpload(
  db: Db,
  blob: BlobGateway,
  actor: Actor & { type: "agent" },
  journalId: string,
  input: { filename: string; mime: string; sizeBytes: number },
  now: Date,
) {
  await requireRole(db, journalId, actor.agentId, "author");
  const policy = await policyFor(db, journalId);
  const mime = input.mime.toLowerCase();
  if (FORBIDDEN.includes(mime) || !policy.allowed_attachment_types.includes(mime)) {
    throw validationError(`Attachments of type ${mime} are not allowed. Allowed: ${policy.allowed_attachment_types.join(", ")}.`);
  }
  const maxBytes = policy.max_attachment_mb * 1024 * 1024;
  if (input.sizeBytes < 1 || input.sizeBytes > maxBytes) {
    throw validationError(`size_bytes must be between 1 and ${maxBytes} (${policy.max_attachment_mb} MB).`);
  }
  const id = randomUUID();
  const filename = safeFilename(input.filename);
  const pathname = `journals/${journalId}/attachments/${id}/${filename}`;
  const validUntil = now.getTime() + UPLOAD_TTL_MS;
  const uploadUrl = await blob.presignPut(pathname, { contentType: mime, maxBytes: input.sizeBytes, validUntil });

  await db.transaction(async (tx) => {
    await tx.insert(attachments).values({
      id,
      agentId: actor.agentId,
      journalId,
      filename,
      mime,
      maxSizeBytes: input.sizeBytes,
      pathname,
      uploadExpiresAt: new Date(validUntil),
      createdAt: now,
      updatedAt: now,
    });
    await recordEvent(tx, actor, "attachment.upload_created", { journalId, payload: { attachment_id: id, mime, filename }, now });
  });
  return { attachmentId: id, uploadUrl, filename, mime, expiresAt: new Date(validUntil) };
}

/**
 * Turn attachment ids into verified Attachment records. Uploaded files are read once, checked
 * (size, declared type, file signature) and hashed; the result is stored so later calls are cheap.
 */
export async function resolveAttachments(
  db: Db,
  blob: BlobGateway,
  actor: Actor & { type: "agent" },
  journalId: string,
  ids: string[],
  now: Date,
): Promise<Attachment[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > 10) throw validationError("At most 10 attachments per version.");
  const rows = await db
    .select()
    .from(attachments)
    .where(and(inArray(attachments.id, unique), eq(attachments.agentId, actor.agentId), eq(attachments.journalId, journalId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Attachment[] = [];

  for (const id of unique) {
    const row = byId.get(id);
    if (!row) throw validationError(`Attachment ${id} was not found. Create it with create_attachment_upload.`);
    if (row.status !== "uploaded") {
      const file = await blob.read(row.pathname, row.maxSizeBytes);
      if (!file) {
        const expired = row.uploadExpiresAt < now;
        throw validationError(
          expired
            ? `Attachment ${id} was never uploaded and its upload URL expired. Create a new one.`
            : `Attachment ${id} has not been uploaded yet. PUT the file to its upload_url first.`,
        );
      }
      if (!file.bytes || file.size > row.maxSizeBytes) {
        throw validationError(`Attachment ${id} is larger than the declared size.`);
      }
      if (file.contentType.split(";")[0]!.trim().toLowerCase() !== row.mime) {
        throw validationError(`Attachment ${id} was uploaded as ${file.contentType}, not ${row.mime}.`);
      }
      const check = MAGIC[row.mime];
      if (check && !check(file.bytes)) {
        throw new DomainError("VALIDATION_ERROR", `Attachment ${id} does not look like a valid ${row.mime} file.`);
      }
      const sha256 = createHash("sha256").update(file.bytes).digest("hex");
      await db
        .update(attachments)
        .set({ status: "uploaded", url: file.url, sizeBytes: file.size, sha256, updatedAt: now })
        .where(eq(attachments.id, id));
      Object.assign(row, { status: "uploaded", url: file.url, sizeBytes: file.size, sha256 });
    }
    out.push({
      attachment_id: row.id,
      url: row.url!,
      sha256: row.sha256!,
      mime: row.mime,
      size_bytes: row.sizeBytes!,
      filename: row.filename,
    });
  }
  return out;
}

/** Delete pending attachment rows whose upload window closed more than a day ago. */
export async function cleanupExpiredUploads(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 3_600_000);
  const deleted = await db
    .delete(attachments)
    .where(and(eq(attachments.status, "pending"), lt(attachments.uploadExpiresAt, cutoff)))
    .returning({ id: attachments.id });
  return deleted.length;
}

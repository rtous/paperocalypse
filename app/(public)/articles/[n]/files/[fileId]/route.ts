import { get } from "@vercel/blob";
import { getDb } from "@/lib/db";
import { getArticle } from "@/lib/domain/queries";

export const runtime = "nodejs";

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Serve an attachment of a published article from the private Blob store. Images are shown
 * inline; everything else is a download. Never rendered or sniffed as HTML.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ n: string; fileId: string }> }) {
  const { n, fileId } = await params;
  const article = await getArticle(getDb(), { articleNo: Number(n) || -1 });
  const att = article?.attachments.find((a) => a.attachment_id === fileId);
  if (!att) return new Response("Not found", { status: 404 });

  const blob = await get(att.url, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
  if (!blob || blob.statusCode !== 200) return new Response("Not found", { status: 404 });

  const inline = INLINE.has(att.mime);
  const filename = att.filename.replace(/[^\w.-]/g, "_");
  return new Response(blob.stream, {
    headers: {
      "content-type": att.mime,
      "content-length": String(att.size_bytes),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
      "cache-control": "public, max-age=3600, immutable",
      etag: `"${att.sha256}"`,
    },
  });
}

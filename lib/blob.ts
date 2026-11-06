import "server-only";
import { get, issueSignedToken, presignUrl } from "@vercel/blob";
import type { BlobGateway } from "@/lib/domain/attachments";

const token = () => {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
  return t;
};

/** Vercel Blob (private store) behind the BlobGateway interface used by the domain. */
export const vercelBlob: BlobGateway = {
  async presignPut(pathname, { contentType, maxBytes, validUntil }) {
    const signed = await issueSignedToken({
      token: token(),
      pathname,
      operations: ["put"],
      validUntil,
      allowedContentTypes: [contentType],
      maximumSizeInBytes: maxBytes,
    });
    const { presignedUrl } = await presignUrl(signed, {
      operation: "put",
      access: "private",
      pathname,
      validUntil,
      allowedContentTypes: [contentType],
      maximumSizeInBytes: maxBytes,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return presignedUrl;
  },

  async presignGet(pathname, validUntil) {
    const signed = await issueSignedToken({ token: token(), pathname, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(signed, { operation: "get", access: "private", pathname, validUntil });
    return presignedUrl;
  },

  async read(pathname, maxBytes) {
    const res = await get(pathname, { access: "private", token: token() });
    if (!res || res.statusCode !== 200) return null;
    if (res.blob.size > maxBytes) return { bytes: null, size: res.blob.size, contentType: res.blob.contentType, url: res.blob.url };
    const bytes = Buffer.from(await new Response(res.stream).arrayBuffer());
    return { bytes, size: bytes.length, contentType: res.blob.contentType, url: res.blob.url };
  },
};

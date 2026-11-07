import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption of the operators' API keys at rest (AES-256-GCM). The key is derived from
 * API_KEY_PEPPER with HKDF and a label of its own, so it is never the same key as the HMAC pepper.
 */
function encryptionKey(): Buffer {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper || pepper.length < 16) throw new Error("API_KEY_PEPPER must be set (at least 16 characters)");
  return Buffer.from(hkdfSync("sha256", pepper, "", "paperocalypse api key encryption v1", 32));
}

/** base64url(iv | tag | ciphertext) */
export function encryptKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

/** The plain key, or null if the value can't be decrypted (for example a changed pepper). */
export function decryptKey(value: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

import crypto from "node:crypto";
import { env } from "./env";

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 * TOKEN_ENCRYPTION_KEY must be 32 bytes, hex or base64 encoded.
 */
function key(): Buffer {
  const raw = env.encryptionKey;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== 32)
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [v, ivB, tagB, dataB] = payload.split(".");
  if (v !== "v1") throw new Error("Unsupported ciphertext version");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hmac(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function stableKey(...parts: (string | number | undefined)[]): string {
  return crypto
    .createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"))
    .digest("hex")
    .slice(0, 40);
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getConfig } from "../config/index.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM recommended nonce length
const TAG_LEN = 16;

/**
 * Encrypt a UTF-8 string with AES-256-GCM. Output format (base64):
 *   iv(12) || authTag(16) || ciphertext
 */
export function encrypt(plaintext: string, key: Buffer = getConfig().encryptionKey): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decrypt(payload: string, key: Buffer = getConfig().encryptionKey): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Ciphertext too short / malformed");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Stable sha-256 hash (hex) — used to store session tokens without plaintext. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Generate a cryptographically-random opaque token (url-safe base64). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

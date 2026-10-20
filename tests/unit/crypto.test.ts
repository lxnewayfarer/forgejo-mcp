import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { encrypt, decrypt, sha256, randomToken } from "../../src/auth/crypto.js";

const KEY = Buffer.alloc(32, 7); // fixed 32-byte key

describe("crypto", () => {
  describe("encrypt/decrypt", () => {
    it("roundtrips a plaintext", () => {
      const plain = "glpat-super-secret-token-value";
      const ct = encrypt(plain, KEY);
      expect(ct).not.toContain(plain);
      expect(decrypt(ct, KEY)).toBe(plain);
    });

    it("produces different ciphertext each call (random IV)", () => {
      const a = encrypt("same", KEY);
      const b = encrypt("same", KEY);
      expect(a).not.toBe(b);
      expect(decrypt(a, KEY)).toBe("same");
      expect(decrypt(b, KEY)).toBe("same");
    });

    it("handles unicode", () => {
      const plain = "héllo 🚀 Forgejo — токен";
      expect(decrypt(encrypt(plain, KEY), KEY)).toBe(plain);
    });

    it("throws on tampered ciphertext (auth tag mismatch)", () => {
      const ct = encrypt("secret", KEY);
      const raw = Buffer.from(ct, "base64");
      raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext body
      const tampered = raw.toString("base64");
      expect(() => decrypt(tampered, KEY)).toThrow();
    });

    it("throws on malformed/too-short payload", () => {
      expect(() => decrypt("AAAA", KEY)).toThrow(/too short|malformed/i);
    });

    it("throws when decrypting with the wrong key", () => {
      const ct = encrypt("secret", KEY);
      const wrong = Buffer.alloc(32, 9);
      expect(() => decrypt(ct, wrong)).toThrow();
    });
  });

  describe("sha256", () => {
    it("is stable and hex-encoded", () => {
      expect(sha256("abc")).toBe(sha256("abc"));
      expect(sha256("abc")).toMatch(/^[0-9a-f]{64}$/);
    });

    it("differs for different inputs", () => {
      expect(sha256("a")).not.toBe(sha256("b"));
    });
  });

  describe("randomToken", () => {
    it("produces unique values", () => {
      const set = new Set(Array.from({ length: 100 }, () => randomToken()));
      expect(set.size).toBe(100);
    });

    it("is url-safe base64 with no padding", () => {
      const t = randomToken(32);
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("respects the byte length argument", () => {
      // 16 bytes -> 22 base64url chars (no padding)
      expect(randomToken(16).length).toBe(22);
    });
  });
});

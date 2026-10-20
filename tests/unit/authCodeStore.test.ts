import { describe, it, expect, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { authCodeStore } from "../../src/auth/authCodeStore.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv));
});

// In-memory fake of oauthCodeRepository; exposes rows for at-rest assertions.
function fakeRepo() {
  const rows = new Map<string, any>();
  return {
    rows,
    async create(row: any) { rows.set(row.codeHash, { ...row }); },
    async peekChallengeValid(codeHash: string, now: Date) {
      const r = rows.get(codeHash);
      if (!r || r.expiresAt.getTime() <= now.getTime()) return null;
      return r.codeChallenge;
    },
    async takeValid(codeHash: string, now: Date) {
      const r = rows.get(codeHash);
      if (!r) return null;
      rows.delete(codeHash);
      if (r.expiresAt.getTime() <= now.getTime()) return null;
      return { clientId: r.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge, userId: r.userId, sessionTokenEnc: r.sessionTokenEnc };
    },
    async deleteExpired() {},
  };
}

const data = {
  clientId: "c1", redirectUri: "http://cb", codeChallenge: "chal",
  sessionId: "s1", userId: "u1", sessionToken: "raw-session-token",
};

describe("authCodeStore", () => {
  it("issues a code, peeks challenge, consumes once returning data", async () => {
    const repo = fakeRepo();
    const store = authCodeStore(repo as any);
    const code = await store.issue(data);

    // sessionToken is encrypted at rest (not plaintext) in sessionTokenEnc
    const stored = [...repo.rows.values()][0];
    expect(stored.sessionTokenEnc).not.toBe("raw-session-token");

    expect(await store.peekChallenge(code)).toBe("chal");
    const got = await store.consume(code);
    expect(got).toMatchObject({
      clientId: "c1", redirectUri: "http://cb", codeChallenge: "chal",
      userId: "u1", sessionToken: "raw-session-token",
    });
    expect(await store.consume(code)).toBeNull(); // single-use
  });

  it("returns null for unknown code", async () => {
    const store = authCodeStore(fakeRepo() as any);
    expect(await store.consume("nope")).toBeNull();
    expect(await store.peekChallenge("nope")).toBeNull();
  });
});

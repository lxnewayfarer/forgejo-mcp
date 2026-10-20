import { describe, it, expect, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { sessionService } from "../../src/auth/sessionService.js";
import { sha256 } from "../../src/auth/crypto.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    SESSION_TTL_HOURS: "1",
  } as NodeJS.ProcessEnv));
});

function fakeRepo(expiresAt: Date = new Date(Date.now() + 3600 * 1000)) {
  const rows = new Map<string, any>();
  return {
    rows,
    async create({ userId, tokenHash, expiresAt: exp }: any) {
      const row = { id: "sess-1", userId, tokenHash, expiresAt: exp ?? expiresAt, revokedAt: null };
      rows.set(tokenHash, row);
      return row;
    },
    async findActiveByHash(h: string) { return rows.get(h) ?? null; },
    async revokeByHash(h: string, when: Date) { const r = rows.get(h); if (r) r.revokedAt = when; },
    async revokeAllForUser(userId: string, when: Date) {
      for (const r of rows.values()) if (r.userId === userId && r.revokedAt === null) r.revokedAt = when;
    },
  };
}

describe("sessionService", () => {
  it("issue and validate returns SessionContext with Date expiresAt", async () => {
    const repo = fakeRepo();
    const svc = sessionService({ repo: repo as any });

    const { token, expiresAt } = await svc.issue({ id: "u1" } as any);
    const ctx = await svc.validate(token);

    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe("u1");
    expect(ctx!.sessionId).toBe("sess-1");
    expect(ctx!.expiresAt).toBeInstanceOf(Date);
    expect(ctx!.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -2);
  });

  it("validate returns null for an expired session", async () => {
    const repo = fakeRepo();
    const svc = sessionService({ repo: repo as any });
    const { token } = await svc.issue({ id: "u1" } as any);
    repo.rows.get(sha256(token))!.expiresAt = new Date(Date.now() - 1000);
    expect(await svc.validate(token)).toBeNull();
  });

  it("validate returns null for a revoked session", async () => {
    const repo = fakeRepo();
    const svc = sessionService({ repo: repo as any });
    const { token } = await svc.issue({ id: "u1" } as any);
    repo.rows.get(sha256(token))!.revokedAt = new Date();
    expect(await svc.validate(token)).toBeNull();
  });

  it("revoke invalidates the session", async () => {
    const repo = fakeRepo();
    const svc = sessionService({ repo: repo as any });
    const { token } = await svc.issue({ id: "u1" } as any);
    expect(await svc.validate(token)).not.toBeNull();
    await svc.revoke(token);
    expect(await svc.validate(token)).toBeNull();
  });

  it("revokeAllForUser revokes every active session for the user", async () => {
    const repo = fakeRepo();
    const svc = sessionService({ repo: repo as any });
    const { token } = await svc.issue({ id: "u1" } as any);
    expect(await svc.validate(token)).not.toBeNull();
    await svc.revokeAllForUser("u1");
    expect(repo.rows.get(sha256(token))!.revokedAt).not.toBeNull();
    expect(await svc.validate(token)).toBeNull();
  });
});

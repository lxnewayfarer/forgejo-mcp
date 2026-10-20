import { describe, it, expect, beforeEach } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { sha256 } from "../../src/auth/crypto.js";
import { refreshTokenService } from "../../src/auth/refreshTokenService.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
  } as NodeJS.ProcessEnv));
});

function fakeRepo() {
  const rows = new Map<string, any>();
  let seq = 0;
  return {
    rows,
    async create({ userId, clientId, familyId, tokenHash, expiresAt }: any) {
      const row = { id: "r" + seq++, userId, clientId, familyId, tokenHash, expiresAt, revokedAt: null };
      rows.set(tokenHash, row); return row;
    },
    async findByHash(h: string) { return rows.get(h) ?? null; },
    async revokeByHash(h: string, when: Date) {
      const r = rows.get(h);
      if (r && r.revokedAt === null) { r.revokedAt = when; return { count: 1 }; }
      return { count: 0 };
    },
    async revokeAllForUser(userId: string, when: Date) {
      let count = 0;
      for (const r of rows.values()) if (r.userId === userId && r.revokedAt === null) { r.revokedAt = when; count++; }
      return { count };
    },
    async revokeFamily(familyId: string, when: Date) {
      let count = 0;
      for (const r of rows.values()) if (r.familyId === familyId && r.revokedAt === null) { r.revokedAt = when; count++; }
      return { count };
    },
  };
}

describe("refreshTokenService", () => {
  it("issues a token and validates it (new family)", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    const ctx = await svc.validate(token);
    expect(ctx).toMatchObject({ userId: "u1", clientId: "c1" });
    expect(ctx!.familyId).toBeTruthy();
  });

  it("rejects a revoked token", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    await svc.revoke(token);
    expect(await svc.validate(token)).toBeNull();
  });

  it("rotate revokes old and issues new in the same family", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token: old } = await svc.issue("u1", "c1");
    const oldFamily = (await svc.validate(old))!.familyId;
    const result = await svc.rotate(old);
    expect(result.reuse).toBe(false);
    expect(await svc.validate(old)).toBeNull();
    const freshCtx = await svc.validate(result.token!);
    expect(freshCtx).toMatchObject({ userId: "u1", clientId: "c1", familyId: oldFamily });
    expect(repo.rows.get(sha256(old))!.revokedAt).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token } = await svc.issue("u1", "c1");
    repo.rows.get(sha256(token))!.expiresAt = new Date(Date.now() - 1000);
    expect(await svc.validate(token)).toBeNull();
  });

  it("detects reuse of an already-rotated token and revokes the whole family", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const { token: t0 } = await svc.issue("u1", "c1");
    const family = (await svc.validate(t0))!.familyId;
    const r1 = await svc.rotate(t0);          // t0 -> t1 (legit)
    const r2 = await svc.rotate(r1.token!);   // t1 -> t2 (legit)

    // Attacker replays the already-rotated t0.
    const replay = await svc.rotate(t0);
    expect(replay.reuse).toBe(true);
    expect(replay.token).toBeUndefined();

    // The entire family is now dead — even the latest legit token t2.
    expect(await svc.validate(r2.token!)).toBeNull();
    for (const r of repo.rows.values()) {
      if (r.familyId === family) expect(r.revokedAt).not.toBeNull();
    }
  });

  it("rotate of an unknown token reports neither success nor reuse", async () => {
    const repo = fakeRepo();
    const svc = refreshTokenService({ repo: repo as any });
    const result = await svc.rotate("never-existed");
    expect(result.reuse).toBe(false);
    expect(result.token).toBeUndefined();
  });
});

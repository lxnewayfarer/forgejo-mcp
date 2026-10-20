import { describe, it, expect, vi } from "vitest";
import { oauthRefreshTokenRepository } from "../../src/repositories/oauthRefreshTokenRepository.js";

function fakeDb() {
  return {
    oAuthRefreshToken: {
      create: vi.fn(async ({ data }: any) => ({ id: "r1", ...data })),
      findUnique: vi.fn(async ({ where }: any) =>
        where.tokenHash === "h" ? { id: "r1", tokenHash: "h", userId: "u1", clientId: "c1", expiresAt: new Date(Date.now() + 1e6), revokedAt: null } : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  } as any;
}

describe("oauthRefreshTokenRepository", () => {
  it("creates, finds, revokes", async () => {
    const db = fakeDb();
    const repo = oauthRefreshTokenRepository(db);
    const expiresAt = new Date();
    await repo.create({ userId: "u1", clientId: "c1", familyId: "f1", tokenHash: "h", expiresAt });
    expect(db.oAuthRefreshToken.create).toHaveBeenCalledOnce();
    expect(db.oAuthRefreshToken.create).toHaveBeenCalledWith({ data: { userId: "u1", clientId: "c1", familyId: "f1", tokenHash: "h", expiresAt } });
    expect(await repo.findByHash("h")).not.toBeNull();
    await repo.revokeByHash("h", new Date());
    expect(db.oAuthRefreshToken.updateMany).toHaveBeenCalled();
  });
});

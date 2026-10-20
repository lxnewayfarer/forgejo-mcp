import { describe, it, expect } from "vitest";
import { oauthCodeRepository } from "../../src/repositories/oauthCodeRepository.js";

function fakePrisma() {
  const rows = new Map<string, any>();
  return {
    rows,
    oAuthCode: {
      async create({ data }: any) { rows.set(data.codeHash, { ...data }); },
      async findUnique({ where: { codeHash } }: any) { return rows.get(codeHash) ?? null; },
      async delete({ where: { codeHash } }: any) {
        const row = rows.get(codeHash);
        if (!row) { const e: any = new Error("not found"); e.code = "P2025"; throw e; }
        rows.delete(codeHash);
        return row;
      },
      async deleteMany() { return { count: 0 }; },
    },
  } as any;
}

const row = {
  codeHash: "h1", clientId: "c1", redirectUri: "http://cb",
  codeChallenge: "chal", userId: "u1", sessionTokenEnc: "ENC",
  expiresAt: new Date(Date.now() + 60_000),
};

describe("oauthCodeRepository", () => {
  it("peekChallengeValid returns challenge without consuming", async () => {
    const repo = oauthCodeRepository(fakePrisma());
    await repo.create(row);
    expect(await repo.peekChallengeValid("h1", new Date())).toBe("chal");
    // still present:
    expect(await repo.peekChallengeValid("h1", new Date())).toBe("chal");
  });

  it("takeValid returns the row once (single-use)", async () => {
    const repo = oauthCodeRepository(fakePrisma());
    await repo.create(row);
    const got = await repo.takeValid("h1", new Date());
    expect(got).toMatchObject({ clientId: "c1", sessionTokenEnc: "ENC" });
    expect(await repo.takeValid("h1", new Date())).toBeNull();
  });

  it("returns null for unknown / expired", async () => {
    const repo = oauthCodeRepository(fakePrisma());
    expect(await repo.takeValid("nope", new Date())).toBeNull();
    expect(await repo.peekChallengeValid("nope", new Date())).toBeNull();
    await repo.create({ ...row, codeHash: "h2", expiresAt: new Date(Date.now() - 1000) });
    expect(await repo.peekChallengeValid("h2", new Date())).toBeNull();
    expect(await repo.takeValid("h2", new Date())).toBeNull();
  });
});

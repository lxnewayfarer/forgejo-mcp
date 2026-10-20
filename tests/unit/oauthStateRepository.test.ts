import { describe, it, expect } from "vitest";
import { oauthStateRepository } from "../../src/repositories/oauthStateRepository.js";

// Minimal in-memory fake of the Prisma oAuthState delegate.
function fakePrisma() {
  const rows = new Map<string, any>();
  return {
    rows,
    oAuthState: {
      async create({ data }: any) { rows.set(data.state, { ...data }); return data; },
      async delete({ where: { state } }: any) {
        const row = rows.get(state);
        if (!row) { const e: any = new Error("not found"); e.code = "P2025"; throw e; }
        rows.delete(state);
        return row;
      },
      async deleteMany({ where }: any) {
        let count = 0;
        for (const [k, v] of rows) {
          if (v.expiresAt.getTime() < where.expiresAt.lt.getTime()) { rows.delete(k); count++; }
        }
        return { count };
      },
    },
  } as any;
}

describe("oauthStateRepository", () => {
  const future = new Date(Date.now() + 60_000);

  it("create then takeValid returns verifier once (single-use)", async () => {
    const repo = oauthStateRepository(fakePrisma());
    await repo.create({ state: "s1", verifier: "v1", expiresAt: future });
    expect(await repo.takeValid("s1", new Date())).toEqual({ verifier: "v1" });
    expect(await repo.takeValid("s1", new Date())).toBeNull(); // consumed
  });

  it("takeValid returns null for unknown state", async () => {
    const repo = oauthStateRepository(fakePrisma());
    expect(await repo.takeValid("nope", new Date())).toBeNull();
  });

  it("takeValid returns null for an expired row (and consumes it)", async () => {
    const repo = oauthStateRepository(fakePrisma());
    const past = new Date(Date.now() - 60_000);
    await repo.create({ state: "s2", verifier: "v2", expiresAt: past });
    expect(await repo.takeValid("s2", new Date())).toBeNull();
  });
});

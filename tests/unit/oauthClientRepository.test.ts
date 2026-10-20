import { describe, it, expect, vi } from "vitest";
import { oauthClientRepository } from "../../src/repositories/oauthClientRepository.js";

function fakeDb() {
  return {
    oAuthClient: {
      create: vi.fn(async ({ data }: any) => ({ id: "c1", ...data })),
      findUnique: vi.fn(async ({ where }: any) =>
        where.clientId === "known" ? { id: "c1", clientId: "known", redirectUris: ["http://cb"], grantTypes: [], clientName: null, clientSecretHash: null } : null,
      ),
    },
  } as any;
}

describe("oauthClientRepository", () => {
  it("creates a client", async () => {
    const db = fakeDb();
    const repo = oauthClientRepository(db);
    const c = await repo.create({ clientId: "abc", redirectUris: ["http://cb"], grantTypes: ["authorization_code"] });
    expect(db.oAuthClient.create).toHaveBeenCalledOnce();
    expect(c.clientId).toBe("abc");
  });

  it("finds by clientId", async () => {
    const repo = oauthClientRepository(fakeDb());
    expect(await repo.findByClientId("known")).not.toBeNull();
    expect(await repo.findByClientId("missing")).toBeNull();
  });
});

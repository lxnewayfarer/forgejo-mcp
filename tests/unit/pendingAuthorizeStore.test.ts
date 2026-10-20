import { describe, it, expect } from "vitest";
import { pendingAuthorizeStore } from "../../src/auth/pendingAuthorizeStore.js";

// In-memory fake of oauthPendingRepository.
function fakeRepo() {
  const rows = new Map<string, any>();
  return {
    async create(data: any) { rows.set(data.state, { ...data }); },
    async takeValid(state: string, now: Date) {
      const row = rows.get(state);
      if (!row) return null;
      rows.delete(state);
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      return {
        clientId: row.clientId, redirectUri: row.redirectUri,
        clientState: row.clientState ?? null, codeChallenge: row.codeChallenge,
      };
    },
    async deleteExpired() {},
  };
}

describe("pendingAuthorizeStore", () => {
  it("saves and takes once", async () => {
    const store = pendingAuthorizeStore(fakeRepo() as any);
    await store.save("state_b", { clientId: "c1", redirectUri: "http://cb", clientState: "xyz", codeChallenge: "chal" });
    const first = await store.take("state_b");
    expect(first).toEqual({ clientId: "c1", redirectUri: "http://cb", clientState: "xyz", codeChallenge: "chal" });
    expect(await store.take("state_b")).toBeNull();
  });
});

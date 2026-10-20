import { describe, it, expect } from "vitest";
import { oauthClientStore } from "../../src/auth/oauthClientStore.js";

function fakeRepo() {
  const byId = new Map<string, any>();
  return {
    byId,
    async create(p: any) { const row = { id: "x", clientSecretHash: null, clientName: p.clientName ?? null, ...p }; byId.set(p.clientId, row); return row; },
    async findByClientId(id: string) { return byId.get(id) ?? null; },
  };
}

describe("oauthClientStore", () => {
  it("registers a client and assigns a client_id", async () => {
    const repo = fakeRepo();
    const store = oauthClientStore({ repo: repo as any });
    const info = await store.registerClient!({
      redirect_uris: ["http://localhost:7777/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      client_name: "Claude Code",
      token_endpoint_auth_method: "none",
    } as any);
    expect(info.client_id).toBeTruthy();
    expect(info.redirect_uris).toEqual(["http://localhost:7777/callback"]);
    expect(repo.byId.has(info.client_id)).toBe(true);
  });

  it("getClient maps a stored row to full info", async () => {
    const repo = fakeRepo();
    const store = oauthClientStore({ repo: repo as any });
    const reg = await store.registerClient!({ redirect_uris: ["http://cb"], grant_types: ["authorization_code"] } as any);
    const got = await store.getClient(reg.client_id);
    expect(got?.client_id).toBe(reg.client_id);
    expect(got?.redirect_uris).toEqual(["http://cb"]);
  });

  it("getClient returns undefined for unknown id", async () => {
    const store = oauthClientStore({ repo: fakeRepo() as any });
    expect(await store.getClient("nope")).toBeUndefined();
  });
});

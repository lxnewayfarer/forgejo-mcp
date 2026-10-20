import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { authRoutes } from "../../src/http/authRoutes.js";
import { stateCookieHeader } from "../helpers/config.js";

const KEY = Buffer.from("a".repeat(64), "hex");

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

// In-memory fakes
function fakes() {
  const pending = new Map<string, any>();
  const states = new Map<string, any>();
  let issuedCode = "";
  return {
    stateStore: {
      async save(s: string, d: any) { states.set(s, d); },
      async take(s: string) { const v = states.get(s); states.delete(s); return v ?? null; },
    },
    pendingStore: {
      async save(s: string, d: any) { pending.set(s, d); },
      async take(s: string) { const v = pending.get(s); pending.delete(s); return v ?? null; },
    },
    codeStore: {
      async issue(_d: any) { issuedCode = "the-code"; return issuedCode; },
      async consume() { return null; },
      async peekChallenge() { return null; },
    },
    sessions: { async issue() { return { token: "sess-tok", expiresAt: new Date(Date.now() + 1e6) }; } },
    users: { async upsertFromForgejo() { return { id: "u1", username: "alice", forgejoUserId: 1, name: "Alice" }; } },
    accounts: { async upsert() {} },
    get issuedCode() { return issuedCode; },
  };
}

describe("/auth/callback OAuth branch", () => {
  it("redirects to the client redirect_uri with code+state when an OAuth request is parked", async () => {
    const f = fakes();
    // Pre-park an OAuth request keyed by the internal state we will use.
    await f.pendingStore.save("st1", { clientId: "c1", redirectUri: "http://localhost:7777/cb", clientState: "cstate", codeChallenge: "chal" });
    // Pre-store the PKCE verifier for that state (as startForgejoLogin would have).
    await f.stateStore.save("st1", { verifier: "v" });

    const exchangeCode = vi.fn(async () => ({ tokens: { access_token: "gl", token_type: "bearer" }, expiresAt: null }));
    const fetchForgejoUser = vi.fn(async () => ({ id: 1, username: "alice", name: "Alice", email: null }));

    const app = express();
    app.use("/auth", authRoutes({
      stateStore: f.stateStore as any, pendingStore: f.pendingStore as any, codeStore: f.codeStore as any,
      sessions: f.sessions as any, users: f.users as any, accounts: f.accounts as any,
      exchangeCode, fetchForgejoUser,
    }));

    const res = await request(app).get("/auth/callback?code=glcode&state=st1").set("Cookie", stateCookieHeader("st1", KEY));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe("http://localhost:7777/cb");
    expect(loc.searchParams.get("code")).toBe("the-code");
    expect(loc.searchParams.get("state")).toBe("cstate");
  });

  it("falls back to HTML page when no OAuth request is parked", async () => {
    const f = fakes();
    await f.stateStore.save("st2", { verifier: "v" });
    const exchangeCode = vi.fn(async () => ({ tokens: { access_token: "gl", token_type: "bearer" }, expiresAt: null }));
    const fetchForgejoUser = vi.fn(async () => ({ id: 1, username: "alice", name: "Alice", email: null }));

    const app = express();
    app.use("/auth", authRoutes({
      stateStore: f.stateStore as any, pendingStore: f.pendingStore as any, codeStore: f.codeStore as any,
      sessions: f.sessions as any, users: f.users as any, accounts: f.accounts as any,
      exchangeCode, fetchForgejoUser,
    }));

    const res = await request(app).get("/auth/callback?code=glcode&state=st2").set("Cookie", stateCookieHeader("st2", KEY));
    expect(res.status).toBe(200);
    expect(res.text).toContain("Connected as");
  });

  it("falls back to HTML page (not 502) when pendingStore.take rejects", async () => {
    const f = fakes();
    await f.stateStore.save("st3", { verifier: "v" });
    const exchangeCode = vi.fn(async () => ({ tokens: { access_token: "gl", token_type: "bearer" }, expiresAt: null }));
    const fetchForgejoUser = vi.fn(async () => ({ id: 1, username: "alice", name: "Alice", email: null }));

    // Simulate pendingStore failure (e.g. store unavailable)
    const brokenPendingStore = {
      save: async () => {},
      take: async () => { throw new Error("store unavailable"); },
    };

    const app = express();
    app.use("/auth", authRoutes({
      stateStore: f.stateStore as any, pendingStore: brokenPendingStore as any, codeStore: f.codeStore as any,
      sessions: f.sessions as any, users: f.users as any, accounts: f.accounts as any,
      exchangeCode, fetchForgejoUser,
    }));

    const res = await request(app).get("/auth/callback?code=glcode&state=st3").set("Cookie", stateCookieHeader("st3", KEY));
    expect(res.status).toBe(200);
    expect(res.text).toContain("Connected as");
  });
});

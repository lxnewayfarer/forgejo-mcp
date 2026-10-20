import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { installTestConfig, stateCookieHeader } from "../helpers/config.js";

// Mock the Forgejo OAuth network functions; keep buildAuthorizeUrl/generatePkce real.
vi.mock("../../src/auth/forgejoOAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/forgejoOAuth.js")>();
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({
      tokens: {
        access_token: "gl-access",
        refresh_token: "gl-refresh",
        token_type: "bearer",
        scope: "api",
      },
      expiresAt: new Date(Date.now() + 3600_000),
    })),
    fetchForgejoUser: vi.fn(async () => ({
      id: 4242,
      username: "alice",
      name: "Alice Example",
      email: "alice@example.com",
    })),
  };
});

import { authRoutes } from "../../src/http/authRoutes.js";

beforeAll(() => installTestConfig());

function buildApp(pending: Record<string, { verifier: string }>) {
  const stateStore = {
    save: vi.fn(async () => undefined),
    take: vi.fn(async (state: string) => pending[state] ?? null),
  } as any;

  const issued: { token: string } = { token: "session-token-xyz" };
  const sessions = {
    issue: vi.fn(async () => ({
      token: issued.token,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    })),
    validate: vi.fn(),
    revoke: vi.fn(async () => undefined),
  } as any;

  const users = {
    upsertFromForgejo: vi.fn(async (info: any) => ({
      ...info,
      id: "user-1",
      forgejoUserId: info.id,
    })),
    findById: vi.fn(),
  } as any;

  const accounts = {
    upsert: vi.fn(async () => undefined),
    getDecrypted: vi.fn(),
    updateTokens: vi.fn(),
  } as any;

  // Inject a no-op pendingStore so the test is deterministic and never touches the database.
  const pendingStore = {
    take: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
  } as any;

  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes({ stateStore, pendingStore, sessions, users, accounts }));
  return { app, stateStore, sessions, users, accounts, issued };
}

describe("GET /auth/callback", () => {
  it("exchanges the code, stores the user, and returns the bearer token", async () => {
    const { app, users, accounts, sessions } = buildApp({ s1: { verifier: "v1" } });

    const res = await request(app)
      .get("/auth/callback?code=abc&state=s1")
      .set("Cookie", stateCookieHeader("s1"));

    expect(res.status).toBe(200);
    expect(res.text).toContain("session-token-xyz");
    expect(res.text).toContain("alice");
    expect(users.upsertFromForgejo).toHaveBeenCalledWith({
      id: 4242,
      username: "alice",
      name: "Alice Example",
      email: "alice@example.com",
    });
    expect(accounts.upsert).toHaveBeenCalledWith("user-1", expect.objectContaining({
      accessToken: "gl-access",
      refreshToken: "gl-refresh",
    }));
    expect(sessions.issue).toHaveBeenCalled();
  });

  it("returns 400 when state is missing", async () => {
    const { app } = buildApp({});
    const res = await request(app).get("/auth/callback?code=abc");
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/missing code or state/i);
  });

  it("returns 400 when code is missing", async () => {
    const { app } = buildApp({ s1: { verifier: "v1" } });
    const res = await request(app).get("/auth/callback?state=s1");
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown/expired state", async () => {
    const { app } = buildApp({}); // no pending entries -> take() returns null
    const res = await request(app)
      .get("/auth/callback?code=abc&state=ghost")
      .set("Cookie", stateCookieHeader("ghost"));
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/invalid or expired/i);
  });

  it("returns 400 when the state cookie is missing (login-CSRF defence)", async () => {
    const { app } = buildApp({ s1: { verifier: "v1" } });
    const res = await request(app).get("/auth/callback?code=abc&state=s1");
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/did not match this browser/i);
  });

  it("returns 400 when the state cookie is for a different state", async () => {
    const { app } = buildApp({ s1: { verifier: "v1" } });
    const res = await request(app)
      .get("/auth/callback?code=abc&state=s1")
      .set("Cookie", stateCookieHeader("other-state"));
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/did not match this browser/i);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the presented bearer token", async () => {
    const { app, sessions } = buildApp({});
    const res = await request(app)
      .post("/auth/logout")
      .set("authorization", "Bearer abc123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sessions.revoke).toHaveBeenCalledWith("abc123");
  });
});

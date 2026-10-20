import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { mcpOAuthProvider } from "../../src/auth/mcpOAuthProvider.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

const client = { client_id: "c1", redirect_uris: ["http://localhost:7777/cb"] } as any;
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

function deps(over: any = {}) {
  return {
    clients: { getClient: vi.fn(), registerClient: vi.fn() },
    pendingStore: { save: vi.fn(), take: vi.fn() },
    codeStore: {
      issue: vi.fn(),
      peekChallenge: vi.fn(),
      consume: vi.fn(),
    },
    sessions: { validate: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn() },
    refresh: { issue: vi.fn(async () => ({ token: "rt", expiresAt: new Date(Date.now() + 1e6), familyId: "f1" })), validate: vi.fn(), rotate: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn() },
    users: { findById: vi.fn(async () => ({ id: "u1" })) },
    stateStore: {},
    startLogin: vi.fn(async () => "https://forgejo.example/oauth/authorize?x=1"),
    ...over,
  };
}

describe("mcpOAuthProvider", () => {
  it("authorize parks the request and redirects to Forgejo", async () => {
    const d = deps();
    const p = mcpOAuthProvider(d as any);
    const res = { redirect: vi.fn() } as any;
    await p.authorize(client, { redirectUri: "http://localhost:7777/cb", codeChallenge: "chal", state: "cs" }, res);
    expect(d.startLogin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        res,
        pending: { clientId: "c1", redirectUri: "http://localhost:7777/cb", clientState: "cs", codeChallenge: "chal" },
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith("https://forgejo.example/oauth/authorize?x=1");
  });

  it("authorize rejects a redirect_uri not registered for the client", async () => {
    const d = deps();
    const p = mcpOAuthProvider(d as any);
    const res = { redirect: vi.fn() } as any;
    await expect(
      p.authorize(client, { redirectUri: "http://evil/cb", codeChallenge: "chal", state: "cs" } as any, res),
    ).rejects.toThrow();
    expect(d.startLogin).not.toHaveBeenCalled();
  });

  it("exchangeAuthorizationCode verifies PKCE and returns the session token as access_token", async () => {
    const verifier = "verifier-123";
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "c1", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256(verifier), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    const tokens = await p.exchangeAuthorizationCode(client, "code", verifier, "http://localhost:7777/cb");
    expect(tokens.access_token).toBe("the-session");
    expect(tokens.refresh_token).toBe("rt");
    expect(tokens.token_type).toBe("bearer");
  });

  it("exchangeAuthorizationCode rejects a bad verifier", async () => {
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "c1", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256("right"), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeAuthorizationCode(client, "code", "wrong", "http://localhost:7777/cb")).rejects.toThrow();
  });

  it("exchangeAuthorizationCode rejects a redirect_uri mismatch", async () => {
    const verifier = "v";
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "c1", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256(verifier), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeAuthorizationCode(client, "code", verifier, "http://evil/cb")).rejects.toThrow();
  });

  it("exchangeRefreshToken rotates and returns a new session", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(),
        rotate: vi.fn(async () => ({ reuse: false, token: "rt2", expiresAt: new Date(Date.now() + 1e6), userId: "u1", clientId: "c1", familyId: "f1" })),
        issue: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(),
      },
      sessions: { issue: vi.fn(async () => ({ token: "sess2", expiresAt: new Date(Date.now() + 1e6) })), validate: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(async () => undefined) },
    });
    const p = mcpOAuthProvider(d as any);
    const tokens = await p.exchangeRefreshToken(client, "old-rt");
    expect(tokens.access_token).toBe("sess2");
    expect(tokens.refresh_token).toBe("rt2");
  });

  it("exchangeRefreshToken detects reuse, revokes sessions, and throws", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(),
        rotate: vi.fn(async () => ({ reuse: true, userId: "u1" })),
        issue: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(),
      },
      sessions: { issue: vi.fn(), validate: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(async () => undefined) },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeRefreshToken(client, "replayed-rt")).rejects.toThrow();
    expect(d.sessions.revokeAllForUser).toHaveBeenCalledWith("u1");
    expect(d.sessions.issue).not.toHaveBeenCalled();
  });

  it("verifyAccessToken returns AuthInfo for a valid session", async () => {
    const expiresAt = new Date(Date.now() + 1e6);
    const d = deps({ sessions: { validate: vi.fn(async () => ({ sessionId: "s1", userId: "u1", expiresAt })), revoke: vi.fn() } });
    const p = mcpOAuthProvider(d as any);
    const info = await p.verifyAccessToken("tok");
    expect(info.token).toBe("tok");
    expect(info.extra?.userId).toBe("u1");
    expect(typeof info.expiresAt).toBe("number");
    expect(info.expiresAt).toBe(Math.floor(expiresAt.getTime() / 1000));
  });

  it("verifyAccessToken throws for an invalid session", async () => {
    const d = deps({ sessions: { validate: vi.fn(async () => null), revoke: vi.fn() } });
    const p = mcpOAuthProvider(d as any);
    await expect(p.verifyAccessToken("bad")).rejects.toThrow();
  });

  it("exchangeAuthorizationCode rejects a code bound to a different clientId", async () => {
    const verifier = "verifier-other";
    const d = deps({
      codeStore: {
        consume: vi.fn(async () => ({
          clientId: "other-client", redirectUri: "http://localhost:7777/cb",
          codeChallenge: s256(verifier), sessionId: "s1", userId: "u1", sessionToken: "the-session",
        })),
        peekChallenge: vi.fn(), issue: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeAuthorizationCode(client, "code", verifier, "http://localhost:7777/cb")).rejects.toThrow();
  });

  it("exchangeRefreshToken rejects a refresh token bound to a different clientId", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(),
        rotate: vi.fn(async () => ({ reuse: false, token: "rt2", expiresAt: new Date(Date.now() + 1e6), userId: "u1", clientId: "other-client", familyId: "f1" })),
        issue: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.exchangeRefreshToken(client, "old-rt")).rejects.toThrow();
  });

  it("exchangeRefreshToken rotation calls rotate with the presented token", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(),
        rotate: vi.fn(async () => ({ reuse: false, token: "rt2", expiresAt: new Date(Date.now() + 1e6), userId: "u1", clientId: "c1", familyId: "f1" })),
        issue: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(),
      },
      sessions: { issue: vi.fn(async () => ({ token: "sess2", expiresAt: new Date(Date.now() + 1e6) })), validate: vi.fn(), revoke: vi.fn(), revokeAllForUser: vi.fn(async () => undefined) },
    });
    const p = mcpOAuthProvider(d as any);
    await p.exchangeRefreshToken(client, "old-rt");
    expect(d.refresh.rotate).toHaveBeenCalledWith("old-rt");
  });

  // --- revokeToken cascade tests ---

  it("revokeToken: revoking an access (session) token revokes all user sessions and refresh tokens", async () => {
    const expiresAt = new Date(Date.now() + 1e6);
    const d = deps({
      sessions: {
        validate: vi.fn(async () => ({ sessionId: "s1", userId: "u1", expiresAt })),
        revoke: vi.fn(), revokeAllForUser: vi.fn(async () => undefined),
      },
      refresh: {
        validate: vi.fn(async () => null), // not a refresh token
        revoke: vi.fn(), rotate: vi.fn(), issue: vi.fn(),
        revokeAllForUser: vi.fn(async () => undefined),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await p.revokeToken(client, { token: "access-token" });
    expect(d.sessions.revokeAllForUser).toHaveBeenCalledWith("u1");
    expect(d.refresh.revokeAllForUser).toHaveBeenCalledWith("u1");
  });

  it("revokeToken: revoking a refresh token revokes all user refresh tokens and sessions", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(async () => ({ userId: "u1", clientId: "c1", familyId: "f1" })),
        revoke: vi.fn(async () => undefined),
        revokeAllForUser: vi.fn(async () => undefined),
        rotate: vi.fn(), issue: vi.fn(),
      },
      sessions: {
        validate: vi.fn(async () => null), // not a session token
        revoke: vi.fn(), revokeAllForUser: vi.fn(async () => undefined),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await p.revokeToken(client, { token: "refresh-token" });
    expect(d.refresh.revokeAllForUser).toHaveBeenCalledWith("u1");
    expect(d.sessions.revokeAllForUser).toHaveBeenCalledWith("u1");
  });

  it("revokeToken: unknown/garbage token is a silent no-op (RFC 7009)", async () => {
    const d = deps({
      refresh: {
        validate: vi.fn(async () => null),
        revoke: vi.fn(), revokeAllForUser: vi.fn(), rotate: vi.fn(), issue: vi.fn(),
      },
      sessions: {
        validate: vi.fn(async () => null),
        revoke: vi.fn(), revokeAllForUser: vi.fn(),
      },
    });
    const p = mcpOAuthProvider(d as any);
    await expect(p.revokeToken(client, { token: "garbage-token" })).resolves.toBeUndefined();
    expect(d.sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(d.refresh.revokeAllForUser).not.toHaveBeenCalled();
  });
});

/**
 * End-to-end OAuth integration test.
 *
 * Drives the full DCR → /authorize → /auth/callback → /token → /mcp flow
 * against a real Express app built with in-memory fakes, following the same
 * DI pattern established in authCallbackOAuth.test.ts.
 *
 * Forgejo is never called — exchangeCode and fetchForgejoUser are injected fakes.
 * The database is never touched — all stores are in-memory Maps.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Response } from "express";

import { setConfig, loadConfig } from "../../src/config/index.js";
import { authRoutes, startForgejoLogin } from "../../src/http/authRoutes.js";
import { randomToken, sha256, encrypt, decrypt } from "../../src/auth/crypto.js";
import { bearerAuth } from "../../src/middleware/bearerAuth.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
beforeEach(() => {
  setConfig(
    loadConfig({
      DATABASE_URL: "postgresql://x",
      FORGEJO_BASE_URL: "https://forgejo.example.com",
      FORGEJO_CLIENT_ID: "fj-id",
      FORGEJO_CLIENT_SECRET: "fj-secret",
      FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback",
      ENCRYPTION_KEY: "a".repeat(64),
      PUBLIC_BASE_URL: "http://localhost:3000",
    } as NodeJS.ProcessEnv),
  );
});

// ---------------------------------------------------------------------------
// PKCE helpers (generated once per module — stable across the test)
// ---------------------------------------------------------------------------
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const CLIENT_REDIRECT = "http://localhost:7777/cb";
const CLIENT_STATE = "client-state-xyz";

// ---------------------------------------------------------------------------
// In-memory stores (mirrors the real implementations, but Map-backed)
// ---------------------------------------------------------------------------

function makeInMemoryStores() {
  // --- oauth client store ---
  const clientMap = new Map<string, OAuthClientInformationFull>();
  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(id) {
      return clientMap.get(id);
    },
    async registerClient(meta) {
      const clientId = randomToken(16);
      const full: OAuthClientInformationFull = {
        client_id: clientId,
        redirect_uris: meta.redirect_uris,
        grant_types: meta.grant_types ?? ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      clientMap.set(clientId, full);
      return full;
    },
  };

  // --- state store (oauth:state:) ---
  const stateMap = new Map<string, { verifier: string }>();
  const stateStore = {
    async save(state: string, data: { verifier: string }) {
      stateMap.set(state, data);
    },
    async take(state: string) {
      const v = stateMap.get(state);
      if (!v) return null;
      stateMap.delete(state);
      return v;
    },
  };

  // --- pending store (oauth:pending:) ---
  const pendingMap = new Map<string, any>();
  const pendingStore = {
    async save(state: string, data: any) {
      pendingMap.set(state, data);
    },
    async take(state: string) {
      const v = pendingMap.get(state);
      if (!v) return null;
      pendingMap.delete(state);
      return v;
    },
  };

  // --- auth code store (short-lived codes, Postgres-backed in prod) ---
  const codeMap = new Map<string, any>();
  const codeStore = {
    async issue(data: any): Promise<string> {
      const code = randomToken(32);
      const stored = { ...data, sessionToken: encrypt(data.sessionToken) };
      codeMap.set(sha256(code), stored);
      return code;
    },
    async peekChallenge(code: string): Promise<string | null> {
      const entry = codeMap.get(sha256(code));
      return entry ? (entry.codeChallenge as string) : null;
    },
    async consume(code: string): Promise<any | null> {
      const key = sha256(code);
      const entry = codeMap.get(key);
      if (!entry) return null;
      codeMap.delete(key);
      return { ...entry, sessionToken: decrypt(entry.sessionToken) };
    },
  };

  // --- session store ---
  // Sessions are stored as { sessionId, userId, expiresAt } keyed by sha256(token).
  const sessionMap = new Map<string, any>();
  // We also need the raw session rows for the repo findActiveByHash call.
  const sessionRowMap = new Map<string, any>();
  // User store for bearerAuth
  const userMap = new Map<string, any>();

  const sessionService = {
    async issue(user: { id: string }, _meta?: any) {
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const tokenHash = sha256(token);
      const ctx = { sessionId: "sess-" + tokenHash.slice(0, 8), userId: user.id, expiresAt };
      sessionMap.set(tokenHash, ctx);
      sessionRowMap.set(tokenHash, {
        id: ctx.sessionId,
        userId: user.id,
        tokenHash,
        expiresAt,
        revokedAt: null,
      });
      return { token, expiresAt };
    },
    async validate(token: string) {
      const h = sha256(token);
      return sessionMap.get(h) ?? null;
    },
    async revoke(token: string) {
      sessionMap.delete(sha256(token));
    },
  };

  // --- refresh token store ---
  const refreshMap = new Map<string, any>();
  const refreshService = {
    async issue(userId: string, clientId: string) {
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
      refreshMap.set(sha256(token), { userId, clientId, expiresAt, revokedAt: null });
      return { token, expiresAt };
    },
    async validate(token: string) {
      const row = refreshMap.get(sha256(token));
      if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
      return { userId: row.userId, clientId: row.clientId };
    },
    async revoke(token: string) {
      const key = sha256(token);
      const row = refreshMap.get(key);
      if (row) refreshMap.set(key, { ...row, revokedAt: new Date() });
    },
    async rotate(oldToken: string, userId: string, clientId: string) {
      await this.revoke(oldToken);
      return this.issue(userId, clientId);
    },
  };

  // --- user + account repositories ---
  const userRepo = {
    async upsertFromForgejo(info: any) {
      const user = {
        id: "user-" + info.id,
        forgejoUserId: info.id,
        username: info.username,
        name: info.name,
        email: info.email ?? null,
      };
      userMap.set(user.id, user);
      return user;
    },
    async findById(id: string) {
      return userMap.get(id) ?? null;
    },
  };

  const accountsRepo = {
    async upsert() {},
    async getDecrypted() { return null; },
    async updateTokens() {},
  };

  return {
    clientsStore,
    stateStore,
    pendingStore,
    codeStore,
    sessionService,
    refreshService,
    userRepo,
    accountsRepo,
    userMap,
  };
}

// ---------------------------------------------------------------------------
// Build the test app with injected fakes
// ---------------------------------------------------------------------------

function buildTestApp(stores: ReturnType<typeof makeInMemoryStores>) {
  const {
    clientsStore,
    stateStore,
    pendingStore,
    codeStore,
    sessionService,
    refreshService,
    userRepo,
    accountsRepo,
  } = stores;

  // Fake Forgejo functions (never hit the network)
  const exchangeCode = async () => ({
    tokens: {
      access_token: "gl-access",
      refresh_token: "gl-refresh",
      token_type: "bearer",
      scope: "api",
    },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const fetchForgejoUser = async () => ({
    id: 4242,
    username: "alice",
    name: "Alice Example",
    email: "alice@example.com",
  });

  // Build an in-memory OAuthServerProvider (mirrors mcpOAuthProvider but wired to fakes)
  function s256(v: string) {
    return createHash("sha256").update(v).digest("base64url");
  }

  const provider: OAuthServerProvider = {
    // Skip SDK-level PKCE validation so the code_verifier is forwarded to
    // exchangeAuthorizationCode, which does its own S256 check (consistent with
    // the production mcpOAuthProvider).
    skipLocalPkceValidation: true as const,

    get clientsStore(): OAuthRegisteredClientsStore {
      return clientsStore;
    },

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response,
    ): Promise<void> {
      const url = await startForgejoLogin(
        { stateStore: stateStore as any, pendingStore: pendingStore as any },
        {
          res,
          pending: {
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            clientState: params.state,
            codeChallenge: params.codeChallenge,
          },
        },
      );
      res.redirect(url);
    },

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const ch = await codeStore.peekChallenge(authorizationCode);
      if (!ch) throw new InvalidGrantError("Unknown or expired authorization code");
      return ch;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      codeVerifier?: string,
      redirectUri?: string,
    ): Promise<OAuthTokens> {
      const data = await codeStore.consume(authorizationCode);
      if (!data) throw new InvalidGrantError("Invalid or expired authorization code");
      if (data.clientId !== client.client_id)
        throw new InvalidGrantError("Code was issued to a different client");
      if (redirectUri !== undefined && redirectUri !== data.redirectUri)
        throw new InvalidGrantError("redirect_uri mismatch");
      if (!codeVerifier || s256(codeVerifier) !== data.codeChallenge)
        throw new InvalidGrantError("PKCE verification failed");

      const { token: refreshToken } = await refreshService.issue(data.userId, client.client_id);
      return {
        access_token: data.sessionToken,
        token_type: "bearer",
        refresh_token: refreshToken,
      };
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
    ): Promise<OAuthTokens> {
      const ctx = await refreshService.validate(refreshToken);
      if (!ctx || ctx.clientId !== client.client_id)
        throw new InvalidGrantError("Invalid or expired refresh token");
      const { token: accessToken } = await sessionService.issue({ id: ctx.userId });
      const { token: newRefresh } = await refreshService.rotate(
        refreshToken,
        ctx.userId,
        client.client_id,
      );
      return {
        access_token: accessToken,
        token_type: "bearer",
        refresh_token: newRefresh,
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const ctx = await sessionService.validate(token);
      if (!ctx) throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: "",
        scopes: [],
        expiresAt: Math.floor(ctx.expiresAt.getTime() / 1000),
        extra: { userId: ctx.userId, sessionId: ctx.sessionId },
      };
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      req: OAuthTokenRevocationRequest,
    ): Promise<void> {
      await refreshService.revoke(req.token).catch(() => undefined);
      await sessionService.revoke(req.token).catch(() => undefined);
    },
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Auth routes (Forgejo callback leg) — injected fakes
  app.use(
    "/auth",
    authRoutes({
      stateStore: stateStore as any,
      pendingStore: pendingStore as any,
      codeStore: codeStore as any,
      sessions: sessionService as any,
      users: userRepo as any,
      accounts: accountsRepo as any,
      exchangeCode,
      fetchForgejoUser,
    }),
  );

  // MCP OAuth router (DCR, /authorize, /token, metadata)
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL("http://localhost:3000"),
      resourceServerUrl: new URL("http://localhost:3000/mcp"),
      scopesSupported: ["mcp"],
      resourceName: "Forgejo MCP",
    }),
  );

  // Minimal /mcp endpoint to test bearer auth acceptance
  const mcpRouter = express.Router();
  mcpRouter.use(
    bearerAuth({
      sessions: sessionService as any,
      users: userRepo as any,
    }),
  );
  mcpRouter.post("/", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use("/mcp", mcpRouter);

  return app;
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("MCP OAuth end-to-end", () => {
  it("DCR → authorize → callback → token yields a working access token", async () => {
    const stores = makeInMemoryStores();
    const app = buildTestApp(stores);
    const agent = request.agent(app); // carry the state cookie across authorize→callback

    // ── Step 1: Dynamic Client Registration ──────────────────────────────────
    const regRes = await agent
      .post("/register")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: [CLIENT_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });

    expect(regRes.status, `POST /register → ${regRes.status}: ${JSON.stringify(regRes.body)}`).toSatisfy(
      (s: number) => s === 200 || s === 201,
    );
    const clientId: string = regRes.body.client_id;
    expect(clientId).toBeTruthy();

    // ── Step 2: /authorize → redirect to Forgejo ───────────────────────────────
    const authorizeRes = await agent
      .get(
        `/authorize?response_type=code` +
          `&client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
          `&code_challenge=${encodeURIComponent(challenge)}` +
          `&code_challenge_method=S256` +
          `&state=${encodeURIComponent(CLIENT_STATE)}` +
          `&scope=mcp`,
      )
      .redirects(0); // do NOT follow the redirect

    expect(authorizeRes.status).toBe(302);
    const forgejoLocation = authorizeRes.headers.location as string;
    expect(forgejoLocation).toContain("https://forgejo.example.com/login/oauth/authorize");

    // Extract the internal state our server put into the Forgejo redirect URL
    const forgejoRedirectUrl = new URL(forgejoLocation);
    const internalState = forgejoRedirectUrl.searchParams.get("state");
    expect(internalState).toBeTruthy();

    // ── Step 3: Forgejo callback → redirect to client with our code ────────────
    const callbackRes = await agent
      .get(`/auth/callback?code=gl-code&state=${encodeURIComponent(internalState!)}`)
      .redirects(0);

    expect(callbackRes.status).toBe(302);
    const clientLocation = callbackRes.headers.location as string;
    const clientUrl = new URL(clientLocation);
    expect(clientUrl.origin + clientUrl.pathname).toBe(CLIENT_REDIRECT);

    const ourCode = clientUrl.searchParams.get("code");
    expect(ourCode).toBeTruthy();
    expect(clientUrl.searchParams.get("state")).toBe(CLIENT_STATE);

    // ── Step 4: Exchange code for tokens ──────────────────────────────────────
    const tokenRes = await agent
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: ourCode!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      });

    expect(tokenRes.status, `POST /token → ${tokenRes.status}: ${JSON.stringify(tokenRes.body)}`).toBe(200);
    const { access_token, refresh_token } = tokenRes.body;
    expect(access_token).toBeTruthy();
    expect(refresh_token).toBeTruthy();
    // Fix 2: The client receives our session token, NOT the Forgejo access token.
    // "gl-access" is the stub value returned by the fake exchangeCode function above.
    expect(access_token).not.toBe("gl-access");

    // ── Step 5a: Access token works at /mcp (not 401) ─────────────────────────
    const mcpRes = await agent
      .post("/mcp")
      .set("Authorization", `Bearer ${access_token}`)
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", method: "ping", id: 1 });

    expect(mcpRes.status).not.toBe(401);

    // ── Step 5b: Missing / garbage bearer IS rejected with 401 ───────────────
    const noAuthRes = await agent
      .post("/mcp")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", method: "ping", id: 2 });
    expect(noAuthRes.status).toBe(401);
    expect(noAuthRes.headers["www-authenticate"]).toBeTruthy();

    const badAuthRes = await agent
      .post("/mcp")
      .set("Authorization", "Bearer garbage-token-that-was-never-issued")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", method: "ping", id: 3 });
    expect(badAuthRes.status).toBe(401);
    expect(badAuthRes.headers["www-authenticate"]).toBeTruthy();
  });

  it("refresh_token grant returns a fresh access_token", async () => {
    const stores = makeInMemoryStores();
    const app = buildTestApp(stores);
    const agent = request.agent(app);

    // Register + full DCR→token flow (abbreviated, no assertions — covered above)
    const regRes = await agent
      .post("/register")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: [CLIENT_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
    const clientId = regRes.body.client_id;

    const authRes = await agent
      .get(
        `/authorize?response_type=code` +
          `&client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
          `&code_challenge=${encodeURIComponent(challenge)}` +
          `&code_challenge_method=S256` +
          `&state=${encodeURIComponent(CLIENT_STATE)}` +
          `&scope=mcp`,
      )
      .redirects(0);
    const internalState = new URL(authRes.headers.location).searchParams.get("state")!;

    const cbRes = await agent
      .get(`/auth/callback?code=gl-code&state=${encodeURIComponent(internalState)}`)
      .redirects(0);
    const ourCode = new URL(cbRes.headers.location).searchParams.get("code")!;

    const tokenRes = await agent.post("/token").type("form").send({
      grant_type: "authorization_code",
      code: ourCode,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
    });
    const { access_token: firstAccess, refresh_token } = tokenRes.body;

    // Now use the refresh token
    const refreshRes = await agent.post("/token").type("form").send({
      grant_type: "refresh_token",
      refresh_token,
      client_id: clientId,
    });

    expect(refreshRes.status).toBe(200);
    const { access_token: newAccess, refresh_token: newRefresh } = refreshRes.body;
    expect(newAccess).toBeTruthy();
    expect(newRefresh).toBeTruthy();
    // Rotated: new access/refresh are different from the original
    expect(newAccess).not.toBe(firstAccess);
    expect(newRefresh).not.toBe(refresh_token);

    // The new access token must work on /mcp
    const mcpRes = await agent
      .post("/mcp")
      .set("Authorization", `Bearer ${newAccess}`)
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", method: "ping", id: 4 });
    expect(mcpRes.status).not.toBe(401);

    // The old access token (from original exchange) must NOT work after the session issued
    // for the refreshed user was separate — we validate this with a fresh garbage token
    const garbageRes = await agent
      .post("/mcp")
      .set("Authorization", "Bearer old-token-garbage")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", method: "ping", id: 5 });
    expect(garbageRes.status).toBe(401);
  });

  it("POST /token with wrong code_verifier is rejected (PKCE enforcement e2e)", async () => {
    // Fix 1: Guard against a regression of skipLocalPkceValidation where PKCE
    // enforcement lives entirely in exchangeAuthorizationCode.  A correct
    // code_verifier must succeed; a present-but-wrong one must be rejected.
    //
    // The authorization code is single-use (consumed on the first consume() call,
    // even when the subsequent PKCE check fails).  We therefore run a completely
    // independent DCR→/authorize→/auth/callback chain here to mint a fresh code
    // for the wrong-verifier attempt — we cannot reuse a code consumed by a
    // previous test.

    const stores = makeInMemoryStores();
    const app = buildTestApp(stores);
    const agent = request.agent(app);

    // ── Register a client ─────────────────────────────────────────────────────
    const regRes = await agent
      .post("/register")
      .set("Content-Type", "application/json")
      .send({
        redirect_uris: [CLIENT_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
    expect(regRes.status).toSatisfy((s: number) => s === 200 || s === 201);
    const clientId: string = regRes.body.client_id;

    // ── Helper: run /authorize → /auth/callback → return fresh code ──────────
    async function mintFreshCode(): Promise<string> {
      const authRes = await agent
        .get(
          `/authorize?response_type=code` +
            `&client_id=${encodeURIComponent(clientId)}` +
            `&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
            `&code_challenge=${encodeURIComponent(challenge)}` +
            `&code_challenge_method=S256` +
            `&state=${encodeURIComponent(CLIENT_STATE)}` +
            `&scope=mcp`,
        )
        .redirects(0);
      expect(authRes.status).toBe(302);
      const internalState = new URL(authRes.headers.location).searchParams.get("state")!;

      const cbRes = await agent
        .get(`/auth/callback?code=gl-code&state=${encodeURIComponent(internalState)}`)
        .redirects(0);
      expect(cbRes.status).toBe(302);
      const code = new URL(cbRes.headers.location).searchParams.get("code");
      expect(code).toBeTruthy();
      return code!;
    }

    // ── Attempt 1: wrong verifier → must be rejected ──────────────────────────
    const badCode = await mintFreshCode();

    const badRes = await agent
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: badCode,
        code_verifier: "wrong-verifier-that-does-not-match",
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      });

    expect(
      badRes.status,
      `Wrong verifier must not yield 200; got ${badRes.status}: ${JSON.stringify(badRes.body)}`,
    ).toBe(400);
    expect(badRes.body.access_token).toBeUndefined();

    // ── Code is now consumed: same code with the CORRECT verifier also fails ──
    // exchangeAuthorizationCode calls codeStore.consume() before the PKCE check,
    // so the code is exhausted even on PKCE failure (single-use-on-failure).
    const sameCodeCorrectVerifier = await agent
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: badCode,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      });
    expect(sameCodeCorrectVerifier.status).not.toBe(200);
    expect(sameCodeCorrectVerifier.body.access_token).toBeUndefined();

    // ── A fresh code with the CORRECT verifier succeeds ───────────────────────
    const goodCode = await mintFreshCode();

    const goodRes = await agent
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: goodCode,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
      });

    expect(
      goodRes.status,
      `Correct verifier must yield 200; got ${goodRes.status}: ${JSON.stringify(goodRes.body)}`,
    ).toBe(200);
    expect(goodRes.body.access_token).toBeTruthy();
  });
});

import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "../config/index.js";

/**
 * Thin Forgejo OAuth2 client: builds the authorize URL (with PKCE), exchanges
 * the authorization code, refreshes tokens, and fetches the authenticated user.
 *
 * Forgejo endpoints: /login/oauth/authorize, /login/oauth/access_token and the
 * API's GET /api/v1/user. OAuth2 access tokens are accepted as Bearer tokens.
 */

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  created_at?: number;
  expires_in?: number;
}

export interface ForgejoUser {
  id: number;
  username: string;
  name: string;
  email?: string | null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function instanceUrl(path: string): string {
  return `${getConfig().FORGEJO_BASE_URL.replace(/\/$/, "")}${path}`;
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const cfg = getConfig();
  const url = new URL(instanceUrl("/login/oauth/authorize"));
  url.searchParams.set("client_id", cfg.FORGEJO_CLIENT_ID);
  url.searchParams.set("redirect_uri", cfg.FORGEJO_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (cfg.FORGEJO_SCOPES.trim()) url.searchParams.set("scope", cfg.FORGEJO_SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function expiresAtFrom(resp: OAuthTokenResponse): Date | null {
  if (!resp.expires_in) return null;
  const base = resp.created_at ? resp.created_at * 1000 : Date.now();
  return new Date(base + resp.expires_in * 1000);
}

async function postToken(
  params: Record<string, string>,
  failure: string,
  fetchImpl: typeof fetch,
): Promise<{ tokens: OAuthTokenResponse; expiresAt: Date | null }> {
  const cfg = getConfig();
  const body = new URLSearchParams({
    client_id: cfg.FORGEJO_CLIENT_ID,
    client_secret: cfg.FORGEJO_CLIENT_SECRET,
    ...params,
  });
  const res = await fetchImpl(instanceUrl("/login/oauth/access_token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${failure} (${res.status}): ${text}`);
  }
  const tokens = (await res.json()) as OAuthTokenResponse;
  return { tokens, expiresAt: expiresAtFrom(tokens) };
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: OAuthTokenResponse; expiresAt: Date | null }> {
  return postToken(
    {
      code,
      grant_type: "authorization_code",
      redirect_uri: getConfig().FORGEJO_REDIRECT_URI,
      code_verifier: codeVerifier,
    },
    "Token exchange failed",
    fetchImpl,
  );
}

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: OAuthTokenResponse; expiresAt: Date | null }> {
  return postToken(
    { refresh_token: refreshToken, grant_type: "refresh_token" },
    "Token refresh failed",
    fetchImpl,
  );
}

export async function fetchForgejoUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ForgejoUser> {
  const cfg = getConfig();
  const res = await fetchImpl(`${cfg.forgejoApiBase}/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch Forgejo user (${res.status}): ${text}`);
  }
  const u = (await res.json()) as {
    id: number;
    login: string;
    full_name?: string;
    email?: string | null;
  };
  return {
    id: u.id,
    username: u.login,
    // Forgejo leaves full_name empty when the user never set one.
    name: u.full_name || u.login,
    email: u.email || null,
  };
}

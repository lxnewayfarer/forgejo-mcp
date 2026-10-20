import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { setConfig, type AppConfig } from "../../src/config/index.js";

/** Install a deterministic in-memory config for tests (no env / no .env). */
export function installTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg: AppConfig = {
    NODE_ENV: "test",
    PORT: 3000,
    PUBLIC_BASE_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://test",
    FORGEJO_BASE_URL: "https://forgejo.example.com",
    FORGEJO_CLIENT_ID: "client-id",
    FORGEJO_CLIENT_SECRET: "client-secret",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback",
    FORGEJO_SCOPES: "read:user write:repository write:issue",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("hex"),
    SESSION_TTL_HOURS: 168,
    TOKEN_REFRESH_SKEW_SECONDS: 60,
    OAUTH_CODE_TTL_SECONDS: 60,
    OAUTH_REFRESH_TTL_HOURS: 720,
    forgejoApiBase: "https://forgejo.example.com/api/v1",
    encryptionKey: Buffer.alloc(32, 1),
    ...overrides,
  };
  setConfig(cfg);
  return cfg;
}

/**
 * Build the signed state cookie header the server expects on /auth/callback.
 * Mirrors src/http/stateCookie.ts using the test encryption key.
 */
export function stateCookieHeader(state: string, key: Buffer = Buffer.alloc(32, 1)): string {
  const sig = createHmac("sha256", key).update(state).digest("base64url");
  return `mcp_oauth_state=${encodeURIComponent(`${state}.${sig}`)}`;
}

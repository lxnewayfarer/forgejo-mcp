import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/index.js";

const base = {
  DATABASE_URL: "postgresql://x",
  FORGEJO_BASE_URL: "https://forgejo.example.com",
  FORGEJO_CLIENT_ID: "id",
  FORGEJO_CLIENT_SECRET: "secret",
  FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback",
  ENCRYPTION_KEY: "a".repeat(64), // 64 hex chars = 32 bytes
};

describe("config OAuth TTLs", () => {
  it("defaults code TTL to 60s and refresh TTL to 720h", () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv);
    expect(cfg.OAUTH_CODE_TTL_SECONDS).toBe(60);
    expect(cfg.OAUTH_REFRESH_TTL_HOURS).toBe(720);
  });

  it("reads overrides from env", () => {
    const cfg = loadConfig({ ...base, OAUTH_CODE_TTL_SECONDS: "30", OAUTH_REFRESH_TTL_HOURS: "168" } as NodeJS.ProcessEnv);
    expect(cfg.OAUTH_CODE_TTL_SECONDS).toBe(30);
    expect(cfg.OAUTH_REFRESH_TTL_HOURS).toBe(168);
  });
});

describe("ENCRYPTION_KEY validation", () => {
  it("accepts 64 hex chars", () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: "a".repeat(64) } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("accepts valid base64 of exactly 32 bytes", () => {
    const b64 = Buffer.alloc(32, 7).toString("base64");
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: b64 } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("rejects a short ASCII passphrase that lenient base64 would silently accept", () => {
    // 32 ASCII chars: NOT 64-hex, decodes via base64 to ~24 bytes — must be rejected, not coerced.
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: "this-is-a-weak-passphrase-123456" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects base64 that does not decode to 32 bytes", () => {
    const b64 = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: b64 } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("production hardening gate", () => {
  const prodBase = { ...base, NODE_ENV: "production", PUBLIC_BASE_URL: "https://mcp.example.com", FORGEJO_REDIRECT_URI: "https://mcp.example.com/auth/callback", DATABASE_URL: "postgresql://u:strongpw@db.internal:5432/app" };

  it("accepts a hardened production config", () => {
    expect(() => loadConfig(prodBase as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("rejects http PUBLIC_BASE_URL in production", () => {
    expect(() => loadConfig({ ...prodBase, PUBLIC_BASE_URL: "http://mcp.example.com" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects localhost datastores in production", () => {
    expect(() => loadConfig({ ...prodBase, DATABASE_URL: "postgresql://forgejo_mcp:forgejo_mcp@localhost:5432/db" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects the default weak DB password in production", () => {
    expect(() => loadConfig({ ...prodBase, DATABASE_URL: "postgresql://forgejo_mcp:forgejo_mcp@db.internal:5432/db" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("does not apply the gate in development", () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: "http://localhost:3000" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe("Forgejo API base", () => {
  it("derives /api/v1 from the instance origin, tolerating a trailing slash", () => {
    const cfg = loadConfig({ ...base, FORGEJO_BASE_URL: "https://git.example.org/" } as NodeJS.ProcessEnv);
    expect(cfg.forgejoApiBase).toBe("https://git.example.org/api/v1");
  });

  it("requires FORGEJO_BASE_URL", () => {
    const { FORGEJO_BASE_URL: _omit, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow();
  });
});

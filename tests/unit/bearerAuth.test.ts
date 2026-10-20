import { describe, it, expect, beforeEach, vi } from "vitest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { bearerAuth } from "../../src/middleware/bearerAuth.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

function mockRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 0,
    body: undefined as unknown,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

describe("bearerAuth WWW-Authenticate", () => {
  it("sets WWW-Authenticate on missing token", async () => {
    const mw = bearerAuth({ sessions: { validate: vi.fn() } as any, users: {} as any });
    const req = { header: () => "" } as any;
    const res = mockRes();
    await mw(req as any, res as any, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"');
  });

  it("sets WWW-Authenticate on invalid session", async () => {
    const mw = bearerAuth({ sessions: { validate: vi.fn(async () => null) } as any, users: {} as any });
    const req = { header: (h: string) => (h.toLowerCase() === "authorization" ? "Bearer bad" : "") } as any;
    const res = mockRes();
    await mw(req as any, res as any, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"');
  });
});

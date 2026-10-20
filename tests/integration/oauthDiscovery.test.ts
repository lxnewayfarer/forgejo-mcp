import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { setConfig, loadConfig } from "../../src/config/index.js";
import { createApp } from "../../src/http/app.js";

beforeEach(() => {
  setConfig(loadConfig({
    DATABASE_URL: "postgresql://x", FORGEJO_BASE_URL: "https://forgejo.example.com", FORGEJO_CLIENT_ID: "id", FORGEJO_CLIENT_SECRET: "s",
    FORGEJO_REDIRECT_URI: "http://localhost:3000/auth/callback", ENCRYPTION_KEY: "a".repeat(64),
    PUBLIC_BASE_URL: "http://localhost:3000",
  } as NodeJS.ProcessEnv));
});

describe("OAuth discovery", () => {
  it("serves authorization-server metadata with our endpoints", async () => {
    const res = await request(createApp()).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("http://localhost:3000/");
    expect(res.body.authorization_endpoint).toContain("/authorize");
    expect(res.body.token_endpoint).toContain("/token");
    expect(res.body.registration_endpoint).toContain("/register");
  });

  it("serves protected-resource metadata", async () => {
    const res = await request(createApp()).get("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBeTruthy();
  });
});

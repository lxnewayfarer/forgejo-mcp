import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { getConfig } from "../config/index.js";
import { mcpOAuthProvider } from "../auth/mcpOAuthProvider.js";
import { authRoutes } from "./authRoutes.js";
import { mcpRoute } from "./mcpRoute.js";

/** Build the Express application (no listen) — convenient for tests. */
export function createApp(): Express {
  const app = express();
  const cfg = getConfig();

  // We sit behind a reverse proxy in the documented deployment. Trust exactly
  // one hop so req.ip / req.protocol reflect the client, without making
  // X-Forwarded-For spoofable from arbitrary upstreams.
  app.set("trust proxy", 1);

  app.use(helmet());

  // Restrict cross-origin access to the configured public origin. The MCP
  // Streamable HTTP transport is a DNS-rebinding / cross-origin target, so we
  // do not allow arbitrary origins. Same-origin/no-origin (curl, server-side
  // MCP clients) requests have no Origin header and are unaffected.
  app.use(
    cors({
      origin: [cfg.PUBLIC_BASE_URL.replace(/\/$/, "")],
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id"],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Forgejo MCP Server</title>
         <h1>Forgejo MCP Server</h1>
         <p><a href="/auth/login">Log in with Forgejo</a> to obtain an MCP bearer token.</p>`,
      );
  });

  app.use("/auth", authRoutes());

  app.use(
    mcpAuthRouter({
      provider: mcpOAuthProvider(),
      issuerUrl: new URL(cfg.PUBLIC_BASE_URL),
      resourceServerUrl: new URL(`${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`),
      scopesSupported: ["mcp"],
      resourceName: "Forgejo MCP",
    }),
  );

  app.use("/mcp", mcpRoute());

  return app;
}

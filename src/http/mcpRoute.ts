import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getConfig } from "../config/index.js";
import { buildMcpServer } from "../mcp/server.js";
import { bearerAuth } from "../middleware/bearerAuth.js";

/**
 * Streamable HTTP MCP endpoint. Stateless: a fresh server + transport per
 * request, bound to the authenticated user resolved by bearerAuth.
 */
export function mcpRoute(): Router {
  const router = Router();
  router.use(bearerAuth());

  const publicUrl = new URL(getConfig().PUBLIC_BASE_URL);
  // Host header may include a port; cover both forms.
  const allowedHosts = [publicUrl.host, publicUrl.hostname];
  const allowedOrigins = [publicUrl.origin];

  router.post("/", async (req, res) => {
    const auth = req.authCtx!; // guaranteed by bearerAuth
    const server = buildMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      // Reject Host/Origin headers that don't match our public URL — defeats
      // DNS-rebinding attacks that drive the server from a malicious web page.
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      console.error("[mcp] request error:", err);
    }
  });

  // The streamable transport in stateless mode does not support GET/DELETE.
  router.get("/", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)." },
      id: null,
    });
  });

  return router;
}

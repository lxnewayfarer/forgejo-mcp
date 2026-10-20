import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { ForgejoService } from "../services/forgejoService.js";
import { tokenProvider } from "../auth/tokenProvider.js";
import { auditLogRepository } from "../repositories/auditLogRepository.js";
import { mapError } from "../middleware/errors.js";
import { TOOLS } from "./registry.js";
import { sanitizeParams } from "./sanitize.js";
import type { AuthContext, ToolContext, ToolDefinition } from "./types.js";

export interface McpServerDeps {
  tokens?: ReturnType<typeof tokenProvider>;
  audit?: ReturnType<typeof auditLogRepository>;
  makeForgejo?: (accessToken: string) => ForgejoService;
}

/**
 * Build an McpServer bound to a single authenticated user. Each tool handler is
 * wrapped with: lazy Forgejo client (with auto-refreshing token), permission
 * checks (inside handlers), audit logging, and central error mapping.
 */
export function buildMcpServer(auth: AuthContext, deps: McpServerDeps = {}): McpServer {
  const tokens = deps.tokens ?? tokenProvider();
  const audit = deps.audit ?? auditLogRepository();
  const makeForgejo =
    deps.makeForgejo ?? ((token: string) => new ForgejoService(token));

  const server = new McpServer({
    name: "forgejo-mcp-server",
    version: "0.1.0",
  });

  for (const tool of TOOLS) {
    registerTool(server, tool, auth, { tokens, audit, makeForgejo });
  }

  return server;
}

function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  auth: AuthContext,
  deps: {
    tokens: ReturnType<typeof tokenProvider>;
    audit: ReturnType<typeof auditLogRepository>;
    makeForgejo: (accessToken: string) => ForgejoService;
  },
): void {
  const shape = (tool.schema as z.ZodObject<z.ZodRawShape>).shape;

  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: shape },
    // The SDK validates input against inputSchema before invoking this callback.
    async (args: unknown) => {
      const startedAt = Date.now();
      const sanitized = sanitizeParams(args);

      // Audit writes must never change what the caller sees: a failed audit
      // persist must not turn a successful Forgejo mutation into a tool error,
      // nor mask the original error on the failure path. Failures are logged so
      // the "every tool call is audited" guarantee gaps are observable.
      const recordAudit = async (
        entry: Parameters<typeof deps.audit.record>[0],
      ): Promise<void> => {
        try {
          await deps.audit.record(entry);
        } catch (auditErr) {
          console.error(
            `[audit] failed to persist audit log for tool=${tool.name} user=${auth.userId} status=${entry.status}:`,
            auditErr,
          );
        }
      };

      try {
        const accessToken = await deps.tokens.getAccessToken(auth.userId);
        const forgejo = deps.makeForgejo(accessToken);
        const ctx: ToolContext = { auth, forgejo };

        const result = await tool.handler(args, ctx);

        await recordAudit({
          userId: auth.userId,
          forgejoUsername: auth.username,
          toolName: tool.name,
          params: sanitized,
          status: "success",
          executionMs: Date.now() - startedAt,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const mapped = mapError(err);
        await recordAudit({
          userId: auth.userId,
          forgejoUsername: auth.username,
          toolName: tool.name,
          params: sanitized,
          status: "error",
          errorMessage: `[${mapped.kind}] ${mapped.message}`,
          executionMs: Date.now() - startedAt,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `${mapped.kind}: ${mapped.message}` }],
        };
      }
    },
  );
}

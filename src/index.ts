import { getConfig } from "./config/index.js";
import { createApp } from "./http/app.js";
import { disconnectPrisma } from "./database/prisma.js";
import { startOAuthSweep } from "./auth/oauthSweep.js";

const cfg = getConfig();
const app = createApp();

const server = app.listen(cfg.PORT, () => {
  console.log(`[forgejo-mcp] listening on :${cfg.PORT}`);
  console.log(`[forgejo-mcp] Forgejo: ${cfg.FORGEJO_BASE_URL}`);
  console.log(`[forgejo-mcp] log in at ${cfg.PUBLIC_BASE_URL}/auth/login`);
});

const stopSweep = startOAuthSweep();

async function shutdown(signal: string): Promise<void> {
  console.log(`[forgejo-mcp] ${signal} received, shutting down...`);
  server.close();
  stopSweep();
  await disconnectPrisma();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

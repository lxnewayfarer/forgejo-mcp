import { z } from "zod";

/**
 * Centralized, validated configuration. Import config from here — never read
 * process.env directly elsewhere in the codebase.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  // Public URL the server is reachable at (used to build the OAuth redirect and
  // to display the bearer-token connection instructions).
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1),

  // Forgejo instance + OAuth application credentials.
  FORGEJO_BASE_URL: z.string().url(),
  FORGEJO_CLIENT_ID: z.string().min(1),
  FORGEJO_CLIENT_SECRET: z.string().min(1),
  FORGEJO_REDIRECT_URI: z.string().url(),
  // Forgejo OAuth2 scopes. Only enforced when the instance enables
  // [oauth2].ENABLE_ADDITIONAL_GRANT_SCOPES; otherwise the token gets full access.
  FORGEJO_SCOPES: z.string().default("read:user write:repository write:issue"),

  // 32-byte key for AES-256-GCM, supplied as hex (64 chars) or base64.
  ENCRYPTION_KEY: z.string().min(1),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7 days
  // Refresh Forgejo tokens when they expire within this many seconds.
  TOKEN_REFRESH_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(60),
  // TTL for our short-lived authorization codes issued to MCP clients.
  OAUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // TTL for opaque refresh tokens issued to MCP clients (default 30 days).
  OAUTH_REFRESH_TTL_HOURS: z.coerce.number().int().positive().default(720),
});

export type AppConfig = z.infer<typeof schema> & {
  forgejoApiBase: string;
  encryptionKey: Buffer;
};

function decodeKey(raw: string): Buffer {
  // Accept ONLY strict 64-char hex OR strict base64 that round-trips to exactly
  // 32 bytes. Buffer.from(_, "base64") is lenient (it silently ignores invalid
  // characters), so a low-entropy ASCII passphrase could otherwise decode to
  // "some" 32-byte buffer and be accepted as the AES key. We reject anything
  // that does not re-encode to the same value.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const buf = Buffer.from(raw, "base64");
  const reEncoded = buf.toString("base64").replace(/=+$/, "");
  const normalizedInput = raw.replace(/=+$/, "");
  if (buf.length !== 32 || reEncoded !== normalizedInput) {
    throw new Error(
      "ENCRYPTION_KEY must be exactly 64 hex chars or valid base64 of 32 bytes. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return buf;
}

const WEAK_DB_PASSWORDS = ["forgejo_mcp", "postgres", "password", "changeme"];

/**
 * In production, refuse to start with insecure defaults that are fine for local
 * dev: plaintext http origins, localhost datastores, and well-known weak DB
 * passwords. Fail-fast at boot rather than silently running insecurely.
 */
function assertProductionHardening(cfg: z.infer<typeof schema>): void {
  if (cfg.NODE_ENV !== "production") return;
  const problems: string[] = [];

  if (cfg.PUBLIC_BASE_URL.startsWith("http://")) {
    problems.push("PUBLIC_BASE_URL must use https in production");
  }
  if (cfg.FORGEJO_REDIRECT_URI.startsWith("http://")) {
    problems.push("FORGEJO_REDIRECT_URI must use https in production");
  }
  for (const [name, url] of [
    ["DATABASE_URL", cfg.DATABASE_URL],
  ] as const) {
    if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      problems.push(`${name} must not point at localhost in production`);
    }
  }
  const dbPw = (() => {
    try {
      return decodeURIComponent(new URL(cfg.DATABASE_URL).password);
    } catch {
      return "";
    }
  })();
  if (dbPw && WEAK_DB_PASSWORDS.includes(dbPw)) {
    problems.push("DATABASE_URL uses a well-known weak password; set a strong POSTGRES_PASSWORD");
  }

  if (problems.length > 0) {
    throw new Error(`Insecure production configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  assertProductionHardening(parsed);
  return {
    ...parsed,
    forgejoApiBase: `${parsed.FORGEJO_BASE_URL.replace(/\/$/, "")}/api/v1`,
    encryptionKey: decodeKey(parsed.ENCRYPTION_KEY),
  };
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: override the cached config. */
export function setConfig(cfg: AppConfig): void {
  cached = cfg;
}

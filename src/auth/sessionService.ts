import type { User } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { sessionRepository } from "../repositories/sessionRepository.js";
import { randomToken, sha256 } from "./crypto.js";

/**
 * Issues and validates the server's own opaque bearer tokens (sessions).
 * Postgres is the source of truth; the raw token is never stored — only its
 * sha-256 hash.
 */

export interface SessionContext {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

export function sessionService(deps?: {
  repo?: ReturnType<typeof sessionRepository>;
}) {
  const repo = deps?.repo ?? sessionRepository();
  const cfg = getConfig();

  return {
    /** Create a session for a user; returns the raw token (shown once). */
    async issue(
      user: User,
      meta?: { userAgent?: string | null; ip?: string | null },
    ): Promise<{ token: string; expiresAt: Date }> {
      const token = randomToken(32);
      const tokenHash = sha256(token);
      const expiresAt = new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3600 * 1000);
      await repo.create({
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: meta?.userAgent ?? null,
        ip: meta?.ip ?? null,
      });
      return { token, expiresAt };
    },

    /** Validate a raw bearer token. Returns context or null if invalid. */
    async validate(token: string): Promise<SessionContext | null> {
      const tokenHash = sha256(token);
      const row = await repo.findActiveByHash(tokenHash);
      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.expiresAt.getTime() <= Date.now()) return null;
      return { sessionId: row.id, userId: row.userId, expiresAt: row.expiresAt };
    },

    /** Revoke a session by its raw token. */
    async revoke(token: string): Promise<void> {
      await repo.revokeByHash(sha256(token), new Date());
    },

    /** Revoke every active session for a user. */
    async revokeAllForUser(userId: string): Promise<void> {
      await repo.revokeAllForUser(userId, new Date());
    },
  };
}

import { getConfig } from "../config/index.js";
import { randomToken, sha256 } from "./crypto.js";
import { oauthRefreshTokenRepository } from "../repositories/oauthRefreshTokenRepository.js";

/**
 * Issues and validates opaque refresh tokens for MCP clients. The raw token is
 * never stored — only its sha-256 hash.
 *
 * Every token minted from one authorization-code grant shares a `familyId`
 * (the rotation chain). Rotation revokes the presented token and issues a new
 * one in the same family. Presenting an already-revoked token is treated as a
 * theft signal (RFC 9700 / OAuth 2.1): the entire family is revoked so neither
 * the attacker nor the legitimate client can keep rotating.
 */
export function refreshTokenService(deps?: {
  repo?: ReturnType<typeof oauthRefreshTokenRepository>;
}) {
  const repo = deps?.repo ?? oauthRefreshTokenRepository();

  async function mint(
    userId: string,
    clientId: string,
    familyId: string,
  ): Promise<{ token: string; expiresAt: Date; familyId: string }> {
    const cfg = getConfig();
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + cfg.OAUTH_REFRESH_TTL_HOURS * 3600 * 1000);
    await repo.create({ userId, clientId, familyId, tokenHash: sha256(token), expiresAt });
    return { token, expiresAt, familyId };
  }

  return {
    /** Issue the first token of a new rotation family. */
    async issue(
      userId: string,
      clientId: string,
    ): Promise<{ token: string; expiresAt: Date; familyId: string }> {
      return mint(userId, clientId, randomToken(16));
    },

    async validate(
      token: string,
    ): Promise<{ userId: string; clientId: string; familyId: string } | null> {
      const row = await repo.findByHash(sha256(token));
      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.expiresAt.getTime() <= Date.now()) return null;
      return { userId: row.userId, clientId: row.clientId, familyId: row.familyId };
    },

    async revoke(token: string): Promise<void> {
      await repo.revokeByHash(sha256(token), new Date());
    },

    /**
     * Rotate the presented token. Resolves the chain identity from the stored
     * row (the caller is not trusted to supply it). Behaviour:
     *  - unknown token        → { reuse: false }                (nothing to do)
     *  - already-revoked      → { reuse: true } + revoke family (theft signal)
     *  - active, won the race → { reuse: false, token, ... }    (new token issued)
     *  - lost the race        → { reuse: true } + revoke family (concurrent reuse)
     */
    async rotate(
      oldToken: string,
    ): Promise<{
      reuse: boolean;
      token?: string;
      expiresAt?: Date;
      userId?: string;
      clientId?: string;
      familyId?: string;
    }> {
      const row = await repo.findByHash(sha256(oldToken));
      if (!row) return { reuse: false };

      const now = new Date();

      // Already revoked → this is a replay of a rotated/revoked token. Kill the
      // family so any tokens minted from it (by attacker or victim) stop working.
      if (row.revokedAt) {
        await repo.revokeFamily(row.familyId, now);
        return { reuse: true };
      }

      // Atomically consume the token. Exactly one caller can flip revokedAt
      // null→now; anyone who sees count 0 lost the race to a concurrent use.
      const { count } = await repo.revokeByHash(sha256(oldToken), now);
      if (count !== 1) {
        await repo.revokeFamily(row.familyId, now);
        return { reuse: true };
      }

      const minted = await mint(row.userId, row.clientId, row.familyId);
      return {
        reuse: false,
        token: minted.token,
        expiresAt: minted.expiresAt,
        userId: row.userId,
        clientId: row.clientId,
        familyId: row.familyId,
      };
    },

    /** Revoke all refresh tokens belonging to a user (e.g. on logout). */
    async revokeAllForUser(userId: string): Promise<void> {
      await repo.revokeAllForUser(userId, new Date());
    },
  };
}

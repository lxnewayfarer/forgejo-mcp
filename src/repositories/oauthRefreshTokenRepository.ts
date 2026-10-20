import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function oauthRefreshTokenRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(params: {
      userId: string;
      clientId: string;
      familyId: string;
      tokenHash: string;
      expiresAt: Date;
    }) {
      return db.oAuthRefreshToken.create({ data: params });
    },

    async findByHash(tokenHash: string) {
      return db.oAuthRefreshToken.findUnique({ where: { tokenHash } });
    },

    /**
     * Atomically revoke a single not-yet-revoked token by hash. Returns the
     * number of rows affected (1 = we won the race and may proceed, 0 = the
     * token was already revoked or never existed — treat as reuse/abort).
     */
    async revokeByHash(tokenHash: string, when: Date): Promise<{ count: number }> {
      return db.oAuthRefreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: when },
      });
    },

    async revokeAllForUser(userId: string, when: Date) {
      return db.oAuthRefreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: when },
      });
    },

    /** Revoke every token in a rotation family (reuse-detection response). */
    async revokeFamily(familyId: string, when: Date) {
      return db.oAuthRefreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: when },
      });
    },
  };
}

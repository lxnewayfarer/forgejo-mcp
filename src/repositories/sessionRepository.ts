import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function sessionRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(params: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string | null;
      ip?: string | null;
    }) {
      return db.session.create({ data: params });
    },

    async findActiveByHash(tokenHash: string) {
      return db.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
    },

    async revokeByHash(tokenHash: string, when: Date) {
      return db.session.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: when },
      });
    },

    /** Revoke every active session for a user. */
    async revokeAllForUser(userId: string, when: Date): Promise<void> {
      await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: when },
      });
    },
  };
}

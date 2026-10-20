import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function oauthStateRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(data: { state: string; verifier: string; expiresAt: Date }): Promise<void> {
      await db.oAuthState.create({ data });
    },

    /** Atomically claim-and-delete. Returns the verifier only if unexpired. */
    async takeValid(state: string, now: Date): Promise<{ verifier: string } | null> {
      let row: { verifier: string; expiresAt: Date };
      try {
        row = await db.oAuthState.delete({ where: { state } });
      } catch (err) {
        // P2025 = record not found (never existed or already taken).
        if (isNotFound(err)) return null;
        throw err;
      }
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      return { verifier: row.verifier };
    },

    async deleteExpired(now: Date): Promise<void> {
      await db.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
    },
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025";
}

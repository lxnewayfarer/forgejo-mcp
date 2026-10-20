import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export interface PendingRow {
  clientId: string;
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
}

export function oauthPendingRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(data: {
      state: string;
      clientId: string;
      redirectUri: string;
      clientState?: string | null;
      codeChallenge: string;
      expiresAt: Date;
    }): Promise<void> {
      await db.oAuthPending.create({
        data: { ...data, clientState: data.clientState ?? null },
      });
    },

    async takeValid(state: string, now: Date): Promise<PendingRow | null> {
      let row: { clientId: string; redirectUri: string; clientState: string | null; codeChallenge: string; expiresAt: Date };
      try {
        row = await db.oAuthPending.delete({ where: { state } });
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      return {
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        clientState: row.clientState,
        codeChallenge: row.codeChallenge,
      };
    },

    async deleteExpired(now: Date): Promise<void> {
      await db.oAuthPending.deleteMany({ where: { expiresAt: { lt: now } } });
    },
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025";
}

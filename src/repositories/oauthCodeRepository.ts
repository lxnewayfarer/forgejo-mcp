import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export interface CodeRow {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  sessionTokenEnc: string;
}

export function oauthCodeRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(row: CodeRow & { codeHash: string; expiresAt: Date }): Promise<void> {
      await db.oAuthCode.create({ data: row });
    },

    /** Read-only peek; does not consume. Null if missing or expired. */
    async peekChallengeValid(codeHash: string, now: Date): Promise<string | null> {
      const row = await db.oAuthCode.findUnique({ where: { codeHash } });
      if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
      return row.codeChallenge;
    },

    async takeValid(codeHash: string, now: Date): Promise<CodeRow | null> {
      let row: CodeRow & { expiresAt: Date };
      try {
        row = await db.oAuthCode.delete({ where: { codeHash } });
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      return {
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        codeChallenge: row.codeChallenge,
        userId: row.userId,
        sessionTokenEnc: row.sessionTokenEnc,
      };
    },

    async deleteExpired(now: Date): Promise<void> {
      await db.oAuthCode.deleteMany({ where: { expiresAt: { lt: now } } });
    },
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025";
}

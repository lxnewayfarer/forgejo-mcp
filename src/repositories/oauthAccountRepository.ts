import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";
import { encrypt, decrypt } from "../auth/crypto.js";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string;
  scope?: string | null;
  expiresAt?: Date | null;
}

export interface DecryptedOAuthAccount {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  expiresAt: Date | null;
}

export function oauthAccountRepository(db: PrismaClient = getPrisma()) {
  return {
    async upsert(userId: string, tokens: TokenSet) {
      const data = {
        accessToken: encrypt(tokens.accessToken),
        refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
        tokenType: tokens.tokenType ?? "bearer",
        scope: tokens.scope ?? null,
        expiresAt: tokens.expiresAt ?? null,
      };
      return db.oAuthAccount.upsert({
        where: { userId },
        create: { userId, provider: "forgejo", ...data },
        update: data,
      });
    },

    async getDecrypted(userId: string): Promise<DecryptedOAuthAccount | null> {
      const row = await db.oAuthAccount.findUnique({ where: { userId } });
      if (!row) return null;
      return {
        id: row.id,
        userId: row.userId,
        accessToken: decrypt(row.accessToken),
        refreshToken: row.refreshToken ? decrypt(row.refreshToken) : null,
        tokenType: row.tokenType,
        scope: row.scope,
        expiresAt: row.expiresAt,
      };
    },

    async updateTokens(userId: string, tokens: TokenSet) {
      return db.oAuthAccount.update({
        where: { userId },
        data: {
          accessToken: encrypt(tokens.accessToken),
          refreshToken: tokens.refreshToken
            ? encrypt(tokens.refreshToken)
            : undefined,
          expiresAt: tokens.expiresAt ?? null,
          scope: tokens.scope ?? undefined,
        },
      });
    },
  };
}

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export function oauthClientRepository(db: PrismaClient = getPrisma()) {
  return {
    async create(params: {
      clientId: string;
      clientName?: string | null;
      redirectUris: string[];
      grantTypes: string[];
      clientSecretHash?: string | null;
    }) {
      return db.oAuthClient.create({
        data: {
          clientId: params.clientId,
          clientName: params.clientName ?? null,
          redirectUris: params.redirectUris,
          grantTypes: params.grantTypes,
          clientSecretHash: params.clientSecretHash ?? null,
        },
      });
    },

    async findByClientId(clientId: string) {
      return db.oAuthClient.findUnique({ where: { clientId } });
    },
  };
}

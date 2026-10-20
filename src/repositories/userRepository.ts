import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export interface ForgejoUserInfo {
  id: number;
  username: string;
  name: string;
  email?: string | null;
}

export function userRepository(db: PrismaClient = getPrisma()) {
  return {
    async upsertFromForgejo(info: ForgejoUserInfo) {
      return db.user.upsert({
        where: { forgejoUserId: info.id },
        create: {
          forgejoUserId: info.id,
          username: info.username,
          name: info.name,
          email: info.email ?? null,
        },
        update: {
          username: info.username,
          name: info.name,
          email: info.email ?? null,
        },
      });
    },

    async findById(id: string) {
      return db.user.findUnique({ where: { id } });
    },
  };
}

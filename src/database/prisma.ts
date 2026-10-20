import { PrismaClient } from "@prisma/client";

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

/** Test helper to inject a mock/in-memory client. */
export function setPrisma(c: PrismaClient): void {
  client = c;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) await client.$disconnect();
}

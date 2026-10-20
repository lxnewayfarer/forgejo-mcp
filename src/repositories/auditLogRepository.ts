import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "../database/prisma.js";

export interface AuditEntry {
  userId?: string | null;
  forgejoUsername?: string | null;
  toolName: string;
  params: unknown;
  status: "success" | "error";
  errorMessage?: string | null;
  executionMs: number;
}

export function auditLogRepository(db: PrismaClient = getPrisma()) {
  return {
    async record(entry: AuditEntry) {
      return db.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          forgejoUsername: entry.forgejoUsername ?? null,
          toolName: entry.toolName,
          // Prisma Json field. Params are already sanitized by the caller.
          params: (entry.params ?? {}) as object,
          status: entry.status,
          errorMessage: entry.errorMessage ?? null,
          executionMs: entry.executionMs,
        },
      });
    },
  };
}

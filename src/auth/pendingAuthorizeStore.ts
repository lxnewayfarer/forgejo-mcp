import { oauthPendingRepository } from "../repositories/oauthPendingRepository.js";

/**
 * Short-lived store for an MCP client's authorize request while the user is
 * redirected through Forgejo. Keyed by the internal Forgejo `state`. Postgres,
 * 10-minute TTL, single-use via atomic delete.
 */
const TTL_SECONDS = 600;

export interface PendingAuthorize {
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
}

export function pendingAuthorizeStore(repo = oauthPendingRepository()) {
  return {
    async save(internalState: string, data: PendingAuthorize): Promise<void> {
      const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
      await repo.create({ state: internalState, ...data, expiresAt });
    },
    async take(internalState: string): Promise<PendingAuthorize | null> {
      const row = await repo.takeValid(internalState, new Date());
      if (!row) return null;
      return {
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        clientState: row.clientState ?? undefined,
        codeChallenge: row.codeChallenge,
      };
    },
  };
}

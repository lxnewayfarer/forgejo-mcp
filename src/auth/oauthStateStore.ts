import { oauthStateRepository } from "../repositories/oauthStateRepository.js";

/**
 * Short-lived store for OAuth `state` → PKCE verifier, used to survive the
 * round-trip to Forgejo and back. Backed by Postgres with a 10-minute TTL,
 * single-use via atomic delete.
 */
const TTL_SECONDS = 600;

export interface PendingAuth {
  verifier: string;
}

export function oauthStateStore(repo = oauthStateRepository()) {
  return {
    async save(state: string, data: PendingAuth): Promise<void> {
      const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
      await repo.create({ state, verifier: data.verifier, expiresAt });
    },
    async take(state: string): Promise<PendingAuth | null> {
      return repo.takeValid(state, new Date());
    },
  };
}

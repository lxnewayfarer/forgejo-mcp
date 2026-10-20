import { oauthStateRepository } from "../repositories/oauthStateRepository.js";
import { oauthPendingRepository } from "../repositories/oauthPendingRepository.js";
import { oauthCodeRepository } from "../repositories/oauthCodeRepository.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Periodically deletes expired rows from the three OAuth stores. This is
 * physical cleanup only — reads already filter on expiresAt, so a delayed
 * sweep never yields a stale row. Returns a stop function.
 */
export function startOAuthSweep(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  const state = oauthStateRepository();
  const pending = oauthPendingRepository();
  const code = oauthCodeRepository();

  async function sweep(): Promise<void> {
    const now = new Date();
    await Promise.allSettled([
      state.deleteExpired(now),
      pending.deleteExpired(now),
      code.deleteExpired(now),
    ]);
  }

  const timer = setInterval(() => {
    void sweep().catch((err) => console.error("[oauth-sweep] error:", err));
  }, intervalMs);
  // Do not keep the event loop alive solely for the sweep.
  timer.unref?.();

  return () => clearInterval(timer);
}

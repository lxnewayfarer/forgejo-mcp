import { getConfig } from "../config/index.js";
import { AppError } from "../middleware/errors.js";
import { oauthAccountRepository } from "../repositories/oauthAccountRepository.js";
import { refreshAccessToken } from "./forgejoOAuth.js";

/**
 * Returns a valid Forgejo access token for a user, transparently refreshing it
 * when expired or within the configured skew window.
 */
export function tokenProvider(deps?: {
  repo?: ReturnType<typeof oauthAccountRepository>;
  refresh?: typeof refreshAccessToken;
}) {
  const repo = deps?.repo ?? oauthAccountRepository();
  const refresh = deps?.refresh ?? refreshAccessToken;
  const cfg = getConfig();

  return {
    async getAccessToken(userId: string): Promise<string> {
      const account = await repo.getDecrypted(userId);
      if (!account) {
        throw new AppError(
          "unauthenticated",
          "No Forgejo account is linked to your session. Please log in at /auth/login.",
        );
      }

      const needsRefresh =
        account.expiresAt != null &&
        account.expiresAt.getTime() - Date.now() <=
          cfg.TOKEN_REFRESH_SKEW_SECONDS * 1000;

      if (!needsRefresh) return account.accessToken;

      if (!account.refreshToken) {
        throw new AppError(
          "token_expired",
          "Your Forgejo token has expired and cannot be refreshed. Please log in again at /auth/login.",
        );
      }

      try {
        const { tokens, expiresAt } = await refresh(account.refreshToken);
        await repo.updateTokens(userId, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? account.refreshToken,
          expiresAt,
          scope: tokens.scope,
        });
        return tokens.access_token;
      } catch {
        throw new AppError(
          "token_expired",
          "Your Forgejo token expired and refresh failed (it may have been revoked). Please log in again at /auth/login.",
        );
      }
    },
  };
}

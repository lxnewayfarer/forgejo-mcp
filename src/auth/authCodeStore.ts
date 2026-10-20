import { getConfig } from "../config/index.js";
import { oauthCodeRepository } from "../repositories/oauthCodeRepository.js";
import { randomToken, sha256, encrypt, decrypt } from "./crypto.js";

/**
 * Short-lived store for the authorization codes this server issues to MCP
 * clients. The raw code is returned once; only its sha-256 hash is persisted.
 * The bound session token is encrypted at rest. TTL is OAUTH_CODE_TTL_SECONDS,
 * single-use via atomic delete on consume.
 */
export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  sessionId: string;
  userId: string;
  sessionToken: string;
}

export function authCodeStore(repo = oauthCodeRepository()) {
  return {
    async issue(data: AuthCodeData): Promise<string> {
      const cfg = getConfig();
      const code = randomToken(32);
      const expiresAt = new Date(Date.now() + cfg.OAUTH_CODE_TTL_SECONDS * 1000);
      await repo.create({
        codeHash: sha256(code),
        clientId: data.clientId,
        redirectUri: data.redirectUri,
        codeChallenge: data.codeChallenge,
        userId: data.userId,
        sessionTokenEnc: encrypt(data.sessionToken),
        expiresAt,
      });
      return code;
    },

    async peekChallenge(code: string): Promise<string | null> {
      return repo.peekChallengeValid(sha256(code), new Date());
    },

    async consume(code: string): Promise<AuthCodeData | null> {
      const row = await repo.takeValid(sha256(code), new Date());
      if (!row) return null;
      return {
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        codeChallenge: row.codeChallenge,
        sessionId: "", // not persisted; kept for call-site type compatibility
        userId: row.userId,
        sessionToken: decrypt(row.sessionTokenEnc),
      };
    },
  };
}

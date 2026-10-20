import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { randomToken } from "./crypto.js";
import { oauthClientRepository } from "../repositories/oauthClientRepository.js";

/**
 * Adapts our OAuthClient table to the SDK's registered-clients store, which the
 * SDK's DCR handler uses. Public PKCE clients only — no client secret.
 */
export function oauthClientStore(deps?: {
  repo?: ReturnType<typeof oauthClientRepository>;
}): OAuthRegisteredClientsStore {
  const repo = deps?.repo ?? oauthClientRepository();

  function toFull(row: {
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
    grantTypes: string[];
  }): OAuthClientInformationFull {
    return {
      client_id: row.clientId,
      redirect_uris: row.redirectUris as [string, ...string[]],
      grant_types: row.grantTypes,
      client_name: row.clientName ?? undefined,
      token_endpoint_auth_method: "none",
    };
  }

  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      const row = await repo.findByClientId(clientId);
      return row ? toFull(row) : undefined;
    },

    async registerClient(
      client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    ): Promise<OAuthClientInformationFull> {
      const metadata = client as OAuthClientMetadata;
      const clientId = randomToken(16);
      const row = await repo.create({
        clientId,
        clientName: metadata.client_name ?? null,
        redirectUris: [...metadata.redirect_uris],
        grantTypes: metadata.grant_types ?? ["authorization_code", "refresh_token"],
        clientSecretHash: null,
      });
      return {
        ...toFull(row),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
    },
  };
}

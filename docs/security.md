# Security Review

This document reviews the security posture of the Forgejo MCP server. File
references point to the implementation.

## Threat model summary

The server is a multi-user bridge between AI agents (MCP clients) and Forgejo.
The primary assets are: users' Forgejo OAuth tokens, the issued MCP bearer
tokens, and the integrity of actions performed against Forgejo. The main threats
are: token theft (at rest or in transit), privilege escalation beyond a user's
Forgejo permissions, abuse of an overly broad API surface, and leakage of
secrets via logs or errors. The design mitigates these through encryption,
strict authorization delegation to Forgejo, a minimal tool surface, and audit
logging.

## Authentication

- After Forgejo OAuth login, the server issues its **own opaque bearer token**
  (not the Forgejo token) for use with the MCP endpoint
  (`src/auth/sessionService.ts`).
- The bearer token is **never stored in plaintext** — only its **SHA-256 hash**
  is persisted in the `Session` table. The raw token is shown to the user once.
- Sessions have a TTL (`SESSION_TTL_HOURS`) and an explicit expiry timestamp.
- **Revocation / logout:** `POST /auth/logout` invalidates the session; the
  bearer token is then rejected.

### MCP-client OAuth (server as its own Authorization Server)

For MCP clients that support OAuth, the server acts as its **own OAuth 2.0
Authorization Server** layered over Forgejo, so clients never paste a token:

- Clients register via **Dynamic Client Registration** (`POST /register`) and
  obtain tokens through the **authorization-code + PKCE (S256)** grant
  (`/authorize`, `/token`). Forgejo remains the upstream identity provider; the
  Forgejo token never leaves the server.
- The client receives an **opaque session bearer token** plus a separate
  **opaque, rotating refresh token**. Each refresh **rotates** the token: the
  old one is consumed and a new one issued.
- **Refresh-token reuse detection** (RFC 9700 / OAuth 2.1): if a previously
  rotated (already-used) refresh token is replayed, the **entire rotation family
  is revoked**, defeating stolen-token replay.
- **Revocation cascades:** revoking a token (`POST /revoke`) or a session tears
  down both the associated session(s) **and** the linked refresh tokens.
- Refresh-token lifetime is controlled by **`OAUTH_REFRESH_TTL_HOURS`** (default
  720h / 30 days); short-lived authorization codes by `OAUTH_CODE_TTL_SECONDS`.

## Token storage

- Forgejo access **and** refresh tokens are encrypted at rest with
  **AES-256-GCM** (`src/auth/crypto.ts`):
  - 12-byte random IV per encryption,
  - 16-byte GCM authentication tag (tamper detection),
  - 256-bit key derived from `ENCRYPTION_KEY` (must decode to exactly 32 bytes).
- Tokens are decrypted only in memory at the moment of use and are **never
  logged**.
- Rotating `ENCRYPTION_KEY` renders existing ciphertext undecryptable by design
  (see the rotation note in [deployment.md](./deployment.md)).

## OAuth security

- **PKCE (S256)** is used on the authorization code exchange, protecting against
  code interception.
- The OAuth **`state`** parameter is **single-use**, stored in Postgres,
  single-use via atomic delete, with a 10-minute TTL, and validated on
  callback to prevent CSRF.
- The client is **confidential**: the token exchange
  (`POST /login/oauth/access_token`) authenticates with `FORGEJO_CLIENT_SECRET`
  in addition to PKCE.

## Authorization model

- **No privilege elevation. No shared service token.** Every Forgejo call is made
  with the **authenticated user's own access token**, so Forgejo itself enforces
  that user's real permissions.
- Before each repository-scoped tool executes, the server calls
  **`assertRepoAccess`** (`src/services/forgejoService.ts`, `GET
  /repos/{owner}/{repo}`) to confirm the user can access the target repository.
  A `403`/`404` from Forgejo → access denied. (`get_current_user` and
  `find_user` are not repository-scoped and skip this check.)
- The server cannot grant access a user does not already have in Forgejo.

## Attack surface minimization

Only **21 allowlisted MCP tools** are exposed, all addressed by `owner` +
`repo` (and `pull_number` for pull-request tools):

- Pull requests: `create_pull_request`, `update_pull_request`,
  `get_pull_request`, `list_pull_requests`, `get_pull_request_diff`,
  `get_pull_request_shas`.
- Comments & discussions: `add_comment`, `list_pull_request_discussions`,
  `reply_to_review_comment`.
- Review actions: `assign_reviewer`, `set_labels`, `approve_pull_request`,
  `unapprove_pull_request`.
- Forgejo Actions: `get_workflow_run`, `list_workflow_runs`,
  `get_workflow_run_jobs`, `get_job_log` (read-only), and `retry_job` (reruns
  one completed job and its dependents as the user; Forgejo enforces write
  permission).
- Repository (read-only): `get_file_content`.
- Users (read-only): `get_current_user`, `find_user`.

The server explicitly does **not** expose:

- arbitrary / raw Forgejo API calls (no API proxy endpoint),
- merging pull requests,
- re-running whole Actions runs, cancelling runs, or dispatching workflows,
- writing repository contents or pushing commits,
- repository deletion,
- repository settings modification,
- token management,
- runner management,
- organization administration,
- user administration,
- Actions secrets/variables modification.

There is no generic pass-through; the Forgejo REST surface is reachable only
through these specific, validated operations.

> Note on `FORGEJO_SCOPES`: the default `read:user write:repository write:issue`
> is the narrowest set that covers the tools, but Forgejo only enforces OAuth2
> scopes when the instance sets `[oauth2] ENABLE_ADDITIONAL_GRANT_SCOPES = true`.
> **Without that flag, the user's OAuth2 access token has full access to that
> user's account.** Either way the server never exposes that breadth: only the
> 21 tools above can be invoked, and that allowlist — not the token's scope — is
> what bounds what the server does.

## Audit logging

Every tool invocation is recorded in the `AuditLog` table: timestamp, user id,
Forgejo username, tool name, **sanitized parameters**, result status, error (if
any), and execution time. Parameters are scrubbed of secrets via
`sanitizeParams` (`src/mcp/sanitize.ts`) before persistence: values under
secret-looking keys (token, secret, password, authorization, …) are redacted,
and free-text values are scanned for JWTs (the shape of Forgejo OAuth2 access
tokens), credentials following `token ` / `Bearer `, and GitLab-style `gl*-`
tokens. Forgejo personal access tokens are bare 40-character hex strings —
indistinguishable from commit SHAs — so a PAT pasted into free text is only
redacted when it appears in such an auth context.

## Transport security

The MCP bearer token is sent on every request. **In production the server must
run behind HTTPS** (TLS-terminating reverse proxy) so tokens are never
transmitted in cleartext. See [deployment.md](./deployment.md).

## Input validation

Every tool defines a **Zod schema** for its inputs; requests with malformed or
unexpected parameters are rejected before any Forgejo call is made. `owner` and
`repo` must be plain names (no `/`), `pull_number` and run/job IDs are positive
integers, and enums (e.g. PR state, workflow-run status) are constrained.

## Error handling

Errors are mapped to meaningful, **secret-free** messages
(`src/middleware/errors.ts`): `ForgejoApiError` statuses map to
`token_expired` (401), `forbidden` (403), `not_found` (404), `rate_limited`
(429), `upstream_unavailable` (5xx), and `bad_request` (any other status, with
the upstream body logged server-side but not echoed), each a distinct, safe
response. Raw upstream payloads
and secrets are not leaked to the client.

## Operational hardening

- The application runs as a **non-root user** in the container image.
- Datastore credentials and secrets are injected via environment variables, not
  baked into the image.
- Dependencies are pinned via the lockfile; rebuild to pick up security patches.

## Residual risks & recommendations

1. **`ENCRYPTION_KEY` management** — store it in a secret manager (not plain
   env files in source control). Rotation requires all users to re-login;
   perform it as a planned event.
2. **Rate limiting** — consider adding rate limiting in front of `/auth/login`,
   `/auth/callback`, and `/mcp` (e.g. at the reverse proxy) to limit brute-force
   and abuse.
3. **Database encryption at rest** — enable disk/volume encryption for the
   PostgreSQL data directory for defense-in-depth beyond app-level token
   encryption.
4. **Secret management** — use Docker/Kubernetes secrets or a vault for
   `FORGEJO_CLIENT_SECRET`, `ENCRYPTION_KEY`, and `POSTGRES_PASSWORD`.
5. **Scope enforcement** — ask the Forgejo administrator to set
   `[oauth2] ENABLE_ADDITIONAL_GRANT_SCOPES = true` so the requested scopes are
   actually enforced. Without it, a stolen Forgejo access token grants full
   access to that user's account (mitigated by the 1-hour default access-token
   lifetime and encryption at rest).
6. **Audit log retention** — define a retention/rotation policy for `audit_logs`
   consistent with your compliance requirements.

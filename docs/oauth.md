# Forgejo OAuth Configuration Guide

This server authenticates every user with **their own Forgejo account** via
OAuth 2.0. There are **no Personal Access Tokens** — users never paste Forgejo
tokens. Instead they log in through Forgejo, and the server issues its own
**session-scoped opaque bearer token** (default 7-day TTL, configurable via
`SESSION_TTL_HOURS`) for use with the MCP endpoint.

The **primary** way to connect an MCP client is the server's built-in OAuth flow
(no token to copy by hand) — see [§8](#8-connecting-an-mcp-client-eg-claude-code-via-oauth).
The browser login that displays a bearer token to paste manually is the
**fallback** for clients that cannot do OAuth.

## 1. Register an OAuth application

You need a Forgejo OAuth2 application. Register it at one of these levels.

### User-owned application

1. Go to **User Settings → Applications** (`/user/settings/applications`) and
   find the **Manage OAuth2 applications** section.
2. Fill in:
   - **Application name:** e.g. `Forgejo MCP Server`.
   - **Redirect URIs:** `${PUBLIC_BASE_URL}/auth/callback`
     (for local dev: `http://localhost:3000/auth/callback`). One URI per line.
   - **Confidential client:** ✅ **keep checked** (this server keeps a client secret).
3. Click **Create application**.
4. Copy the **Client ID** and **Client Secret**. The secret is shown only once;
   if you lose it, regenerate it on the application's page.

Forgejo has no per-application scope checkboxes — the scopes are requested by
the server in the authorize request (`FORGEJO_SCOPES`, see [§2](#2-required-scopes)).

### Organization or instance application

For a shared deployment you can register the app at a different level so it
isn't tied to one person's account:

- **Organization application:** Organization → **Settings → Applications**
  (`/org/{org}/settings/applications`).
- **Instance-wide application (admin):** **Site Administration → Integrations →
  Applications** (`/admin/applications`).

The fields (application name, redirect URIs, confidential client) are identical.

## 2. Required scopes

The server requests these scopes by default
(`FORGEJO_SCOPES="read:user write:repository write:issue"`):

| Scope | Why it's needed |
|-------|-----------------|
| `read:user` | To read the authenticated user's profile (`GET /api/v1/user`: id, login, full name, email) at login, and for `get_current_user` / `find_user`. |
| `write:repository` | To act on pull requests, reviews, file contents, and Forgejo Actions runs/jobs/logs on the user's behalf. |
| `write:issue` | To post PR comments and set labels — Forgejo serves those through the issue endpoints, which pull requests share. |

The MCP tools call the Forgejo REST API with the user's token, so Forgejo
enforces that user's real permissions on every call.

> **Scopes are only enforced if the instance enables them.** Forgejo checks
> OAuth2 scopes only when `[oauth2] ENABLE_ADDITIONAL_GRANT_SCOPES = true` is set
> in the instance's `app.ini`. Without it, an OAuth2 access token has **full
> access to the user's account**, regardless of `FORGEJO_SCOPES`. Either way,
> this server only ever exposes the **21 allowlisted MCP tools** — it never
> proxies arbitrary API calls — and that allowlist is what bounds what the
> server does. See [security.md](./security.md).

## 3. Confidential client + PKCE

This is a **confidential** application: it authenticates to Forgejo's token
endpoint (`POST /login/oauth/access_token`) using `FORGEJO_CLIENT_SECRET`, and
additionally uses **PKCE (S256)** for the authorization code exchange (Forgejo
supports PKCE for confidential clients). Keep the secret out of client-side code and
version control.

## 4. Map credentials to environment variables

| Forgejo field | Environment variable |
|--------------|----------------------|
| Client ID | `FORGEJO_CLIENT_ID` |
| Client Secret | `FORGEJO_CLIENT_SECRET` |
| Redirect URI | `FORGEJO_REDIRECT_URI` |
| Instance URL | `FORGEJO_BASE_URL` (required; the instance origin, e.g. `https://git.example.com`, without `/api/v1`) |

The redirect URI **must match exactly** — same scheme, host, port, and path —
between the Forgejo app registration and `FORGEJO_REDIRECT_URI`.

## 5. The login flow (manual-token fallback)

This is the browser flow used when an MCP client cannot perform OAuth itself. The
preferred, zero-token-paste path is the client OAuth flow in
[§8](#8-connecting-an-mcp-client-eg-claude-code-via-oauth).

```
1. User opens   GET /auth/login
2. Server redirects to Forgejo's authorize endpoint
   (${FORGEJO_BASE_URL}/login/oauth/authorize with client_id, redirect_uri,
   state, PKCE code_challenge, and scope if FORGEJO_SCOPES is non-empty)
3. User approves on Forgejo
4. Forgejo redirects to GET /auth/callback?code=...&state=...
5. Server validates state, exchanges the code (+ PKCE verifier + secret)
   at /login/oauth/access_token for Forgejo access + refresh tokens
6. Server reads the Forgejo user (GET /api/v1/user), upserts the user
   record, and stores the encrypted tokens
7. Server issues its OWN bearer token and shows it to the user once
8. User pastes that bearer token into their MCP client config:
      URL:    ${PUBLIC_BASE_URL}/mcp
      Header: Authorization: Bearer <token>
```

From then on the MCP client sends the bearer token with each request; the
server resolves it to the user and acts with that user's Forgejo token.

## 6. Token refresh

Forgejo OAuth2 access tokens are JWTs that expire after **1 hour** by default
(`[oauth2] ACCESS_TOKEN_EXPIRATION_TIME = 3600`). The server stores the refresh
token (encrypted) and automatically refreshes the access token when it is within
`TOKEN_REFRESH_SKEW_SECONDS` of expiry — transparently, before each Forgejo
call. Forgejo may rotate the refresh token on refresh; when it returns a new one
the server stores it. Refresh tokens last about 730 hours by default
(`REFRESH_TOKEN_EXPIRATION_TIME`), so users do not need to re-authenticate
unless the refresh token itself is revoked or expires.

## 7. Logout

To revoke a session, send the bearer token to the logout endpoint:

```bash
curl -X POST ${PUBLIC_BASE_URL}/auth/logout \
  -H "Authorization: Bearer <token>"
```

This invalidates the issued bearer token. The user must run `/auth/login` again
to obtain a new one.

## 8. Connecting an MCP client (e.g. Claude Code) via OAuth

The server is an **OAuth 2.0 Authorization Server** for MCP clients. Clients can authenticate without manually pasting tokens.

### Zero-token client setup

Add the server to your MCP client:

```bash
claude mcp add --transport http forgejo http://localhost:3000/mcp
```

On first use:

1. The client discovers `/.well-known/oauth-authorization-server` (server metadata).
2. The client registers itself via `POST /register` (Dynamic Client Registration).
3. The client opens your browser to `GET /authorize`.
4. You log in with **your Forgejo account** (once).
5. Forgejo redirects back; the client exchanges the code for **opaque session + refresh tokens**.
6. The client automatically refreshes tokens before expiry — no re-login needed for up to 30 days (or until the refresh token expires).

The MCP client never sees your Forgejo token; the server holds it encrypted and acts on your behalf.

### Fallback: manual token flow

If your MCP client does not support OAuth, the legacy manual flow still works:

1. Visit `http://localhost:3000/auth/login` in a browser.
2. Authorize with Forgejo.
3. Copy the bearer token shown.
4. Configure your client with:
   - URL: `http://localhost:3000/mcp`
   - Header: `Authorization: Bearer <token>`

## Common pitfalls

| Problem | Fix |
|---------|-----|
| **Redirect URI mismatch** (Forgejo rejects the authorize request because the redirect URI is not registered) | Ensure `FORGEJO_REDIRECT_URI` exactly equals one of the redirect URIs registered on the Forgejo app, including scheme/host/port/path. |
| **Scopes too narrow** (instance has `ENABLE_ADDITIONAL_GRANT_SCOPES = true`) | Login works but tool calls fail with 403. Make sure `FORGEJO_SCOPES` includes `read:user write:repository write:issue`, then log in again so a new token is issued. |
| **Wrong or missing `FORGEJO_BASE_URL`** | The server refuses to start without it, or talks to the wrong host. Set it to your instance origin (e.g. `https://git.example.com`, no trailing `/api/v1`). |
| **App not marked confidential** | The server always sends its client secret; re-create the application with **Confidential client** checked. |
| **Actions tools say "Forgejo N or newer is required"** | The instance predates that API: run jobs and job logs need Forgejo 16, `retry_job` needs 17. Upgrade Forgejo; the other tools are unaffected. |
| **Secret leaked / rotated** | Update `FORGEJO_CLIENT_SECRET` and restart; users may need to log in again. |

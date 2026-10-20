# Setup Guide

This guide covers running the Forgejo MCP server both locally (for development)
and via Docker Compose.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 22+ | Only needed for local (non-Docker) development. |
| npm | 10+ | Ships with Node 22. |
| Docker + Docker Compose | recent | For the Postgres datastore and/or the full stack. |
| A Forgejo OAuth application | — | See [oauth.md](./oauth.md). |

## Environment variables

Copy the example file and edit it:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime environment (`development` / `production`). | `development` |
| `PORT` | Port the HTTP server listens on. | `3000` |
| `PUBLIC_BASE_URL` | Public base URL the server is reached at. Used to build the OAuth redirect and the MCP endpoint URL shown to users. | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string. | `postgresql://forgejo_mcp:forgejo_mcp@localhost:5432/forgejo_mcp?schema=public` |
| `FORGEJO_BASE_URL` | Origin of the Forgejo instance, e.g. `https://git.example.com` (no trailing `/api/v1`; the server appends it). | — (required) |
| `FORGEJO_CLIENT_ID` | OAuth2 application Client ID from Forgejo. | — (required) |
| `FORGEJO_CLIENT_SECRET` | OAuth2 application Client Secret from Forgejo. | — (required) |
| `FORGEJO_REDIRECT_URI` | OAuth callback URL, normally `${PUBLIC_BASE_URL}/auth/callback`. Must match a redirect URI registered on the Forgejo app exactly. | — (required; Docker Compose defaults it to `http://localhost:3000/auth/callback`) |
| `FORGEJO_SCOPES` | Space-separated Forgejo OAuth2 scopes. Only enforced when the instance sets `[oauth2] ENABLE_ADDITIONAL_GRANT_SCOPES = true`; otherwise the token has full access to the user's account and the 20-tool allowlist is what bounds the server. See [oauth.md](./oauth.md#2-required-scopes). | `read:user write:repository write:issue` |
| `ENCRYPTION_KEY` | 32-byte key (hex or base64) for AES-256-GCM token encryption. | — (required) |
| `SESSION_TTL_HOURS` | Lifetime of issued bearer/session tokens. | `168` (7 days) |
| `TOKEN_REFRESH_SKEW_SECONDS` | Refresh Forgejo tokens this many seconds before expiry. | `60` |
| `OAUTH_CODE_TTL_SECONDS` | Lifetime of the short-lived authorization codes issued to MCP clients during the OAuth flow. | `60` |
| `OAUTH_REFRESH_TTL_HOURS` | Lifetime of the opaque, rotating refresh tokens issued to MCP clients. | `720` (30 days) |

### Generating `ENCRYPTION_KEY`

The key must decode to **exactly 32 bytes**. Generate a hex key with:

```bash
openssl rand -hex 32
```

Paste the output into `ENCRYPTION_KEY`. (A base64-encoded 32-byte value also
works, e.g. `openssl rand -base64 32`.)

> ⚠️ Treat this key like a password. If it changes, all previously stored
> Forgejo tokens become undecryptable and every user must log in again.

## Local development

Run the datastores in Docker, and the app directly via Node for fast iteration:

```bash
# 1. Start Postgres only
docker compose up -d postgres

# 2. Install dependencies
npm install

# 3. Generate the Prisma client
npm run db:generate

# 4. Apply database migrations (creates tables)
npm run db:migrate

# 5. Run the dev server (watch mode)
npm run dev
```

The server starts on `http://localhost:3000`. Begin the login flow at
`http://localhost:3000/auth/login`.

## Docker (full stack)

To run everything (Postgres and the app) in containers:

```bash
docker compose up --build
```

This builds the app image, starts all services, runs migrations automatically
on startup, and exposes the server on `http://localhost:3000`.

## Connecting Claude Code

Once the server is running (locally or via Docker), add it to Claude Code as an
HTTP MCP server:

```bash
claude mcp add --transport http forgejo http://localhost:3000/mcp
```

> Replace `http://localhost:3000` with your `PUBLIC_BASE_URL` if the server is
> deployed elsewhere. The path is always `/mcp`.

On first use, Claude Code authenticates via the server's built-in OAuth flow —
no token to copy by hand:

1. Claude Code discovers the server metadata at
   `/.well-known/oauth-authorization-server`.
2. It registers itself via `POST /register` (Dynamic Client Registration).
3. Your browser opens the Forgejo login page — sign in with **your own Forgejo
   account** (once).
4. Forgejo redirects back; Claude Code exchanges the code for opaque session +
   refresh tokens and stores them. Tokens refresh automatically before expiry.

Verify the connection and inspect the available tools:

```bash
claude mcp list          # should show "forgejo" as connected
```

In a Claude Code session, run `/mcp` to see the 21 Forgejo tools.

**If your client can't do OAuth** (or you prefer a manual token), use the
browser fallback: open `http://localhost:3000/auth/login`, authorize with
Forgejo, copy the bearer token shown, and add it as a header:

```bash
claude mcp add --transport http forgejo http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>"
```

See [oauth.md](./oauth.md#8-connecting-an-mcp-client-eg-claude-code-via-oauth)
for the full flow and common pitfalls.

## Running migrations

- **Local development:** `npm run db:migrate` (creates and applies migrations).
- **Production / Docker:** migrations are applied automatically on container
  start via the entrypoint, which runs `prisma migrate deploy`. To apply them
  manually: `npm run db:deploy`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|-------------------|
| `Can't reach database server` | Postgres isn't up or `DATABASE_URL` host is wrong. For local dev the host is `localhost`; inside Docker Compose the app uses `postgres` as the host. Run `docker compose ps` to verify health. |
| `ENCRYPTION_KEY must decode to 32 bytes` | The key isn't a valid 32-byte hex/base64 string. Regenerate with `openssl rand -hex 32`. |
| OAuth redirect error / mismatch | `FORGEJO_REDIRECT_URI` must exactly match the redirect URI registered on the Forgejo OAuth app. See [oauth.md](./oauth.md). |
| Migrations not applied | Ensure the DB is reachable, then run `npm run db:deploy` (or restart the container so the entrypoint runs). |

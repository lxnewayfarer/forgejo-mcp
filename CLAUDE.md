# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## What this is

A production-ready **MCP (Model Context Protocol) server** that lets AI agents
interact with Forgejo through a **curated set of tools (21 total)**. Every user
authenticates with their own Forgejo account via **OAuth 2.0**. The server calls
the **Forgejo REST API v1 directly** (`${FORGEJO_BASE_URL}/api/v1`). It is a port
of `../gitlab-mcp` and keeps its architecture; only the provider layer differs.

```
User → Forgejo OAuth Login → MCP Server → Forgejo REST API
```

## Tech stack

- TypeScript, Node.js 22+ (ESM)
- MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
- Express (HTTP layer + MCP Streamable HTTP transport)
- PostgreSQL + Prisma ORM
- Vitest (tests), Docker Compose (deploy)

## Architecture (clean / layered)

```
src/
  config/         env loading & validation (zod) — import from here, never read process.env elsewhere
  database/       prisma client singleton
  auth/           OAuth flow, PKCE, session service, AES-256-GCM crypto, token refresh
  services/       ForgejoService — the ONLY place allowed to call the Forgejo REST API
  repositories/   Prisma data-access (user, oauthAccount, session, auditLog)
  mcp/            MCP server, tool registry, 21 tool definitions + handlers
  middleware/     bearer auth, audit logging, error mapping
  http/           express app, /auth routes, /mcp route, /healthz
```

### Hard rules (do not break these)

1. **Only `ForgejoService` calls Forgejo.** Tool handlers and routes must never
   `fetch` Forgejo directly. Add new Forgejo interactions as methods on the service.
2. **Only the allowlisted tools exist (currently 21).** Do NOT add tools that
   expose arbitrary API calls, repo/org/runner/secret/variable administration,
   or a raw API proxy. User lookup is limited to `get_current_user` and
   `find_user` (username→id) — no user administration or enumeration beyond that.
   The tool surface is intentionally curated — see `src/mcp/tools/` and
   `src/mcp/registry.ts`. New tools require a security-model check before exposure.
3. **Actions run as the authenticated Forgejo user**, using their own OAuth token.
   No shared service token, no privilege elevation.
4. **Tokens are encrypted at rest** (AES-256-GCM via `src/auth/crypto.ts`). Never
   store or log raw tokens. Session tokens are stored as sha-256 hashes.
5. **Every tool call is audited** (`AuditLog`) with secrets stripped from params.
6. **Config comes from `src/config`** (zod-validated). Don't sprinkle `process.env`.

## The tools (21)

All repo-scoped tools take `owner` + `repo` (no `/` allowed in either) and, for
PRs, `pull_number` (the repo-scoped `#N`). People are referenced by username.

**Pull requests:** `create_pull_request`, `update_pull_request`,
`get_pull_request`, `list_pull_requests`, `get_pull_request_diff`,
`get_pull_request_shas`.

**Comments & discussions:** `add_comment`, `list_pull_request_discussions`,
`reply_to_review_comment`.

**Review actions:** `assign_reviewer`, `set_labels`, `approve_pull_request`,
`unapprove_pull_request`.

**Forgejo Actions:** `get_workflow_run`, `list_workflow_runs`,
`get_workflow_run_jobs`, `get_job_log`, `retry_job`.

**Repository:** `get_file_content` (read a file at a given ref; read-only,
scoped to the user's OAuth access — Forgejo enforces 403/404).

**User lookup:** `get_current_user`, `find_user`.

> Note: creating a *new* inline review comment is intentionally NOT a tool
> (parity with gitlab-mcp). The server reads discussions and replies to
> existing inline threads.

Forgejo specifics worth knowing before changing a tool:

- PRs share the issue endpoints for comments (`/issues/{n}/comments`) and
  labels (`PUT /issues/{n}/labels`, accepts label names).
- Merged PRs come back as `state: "closed"` + `merged: true`; `presentPullRequest`
  reports them as `"merged"`.
- Inline review comments: `position` = new-side line, `original_position` =
  old-side line. Forgejo groups comments on the same path/side/line into one
  conversation, which is how `reply_to_review_comment` works.
- There is no unapprove endpoint; `unapprove_pull_request` deletes the caller's
  own approving review and refuses when it carries inline comments.
- Pagination: `page` + `limit` (max 50), total in `X-Total-Count` (Actions runs
  return `total_count` in the body instead).
- Actions endpoints by release: runs in all supported releases; run jobs +
  job logs from Forgejo 16; job rerun from 17 (`MIN_VERSION` in
  `src/mcp/tools/actions.ts`). A 404 from an instance older than that becomes
  an explicit "Forgejo N or newer is required" error.

Each tool: zod input schema → permission check (`assertRepoAccess`) →
`ForgejoService` call → structured response. Errors map to meaningful MCP
errors (see `src/middleware/errors.ts`).

## Common commands

```bash
npm install
npm run db:generate        # prisma generate
npm run db:migrate         # prisma migrate dev (local)
npm run dev                # tsx watch, local dev server
npm run build              # tsc
npm start                  # run built server
npm test                   # vitest run
npm run test:watch
docker compose up          # full stack (postgres + app, runs migrations)
```

## Environment

See `.env.example`. Key vars: `DATABASE_URL`, `FORGEJO_BASE_URL` (required,
instance origin), `FORGEJO_CLIENT_ID`, `FORGEJO_CLIENT_SECRET`,
`FORGEJO_REDIRECT_URI`, `FORGEJO_SCOPES`, `ENCRYPTION_KEY` (32-byte base64/hex),
`SESSION_TTL_HOURS`, `PORT`, `PUBLIC_BASE_URL`.

## Auth flow (how a user gets connected)

### MCP client (OAuth)

MCP clients can authenticate via the server's own OAuth 2.0 endpoints:
- Discovery: `/.well-known/oauth-authorization-server`
- Dynamic Client Registration: `POST /register`
- Authorization: `GET /authorize` (redirects to Forgejo login once)
- Token exchange & refresh: `POST /token`
- Token revocation: `POST /revoke`

Forgejo is the upstream identity provider; Forgejo tokens never leave the server.
The client receives opaque session tokens (access + rotating refresh tokens).

See [`docs/oauth.md`](docs/oauth.md#8-connecting-an-mcp-client-eg-claude-code-via-oauth) for setup.

### Browser (manual token flow — fallback)

For clients without OAuth support:

1. User opens `GET /auth/login` in a browser.
2. Server redirects to Forgejo's OAuth authorize endpoint (with `state` + PKCE).
3. Forgejo redirects to `GET /auth/callback` → server exchanges code, fetches the
   Forgejo user, stores encrypted tokens, issues an **opaque session bearer token**.
4. User pastes that bearer token into their MCP client config as
   `Authorization: Bearer <token>` for `POST /mcp`.
5. `POST /auth/logout` revokes the session.

## Testing notes

- Forgejo is always mocked in tests (no live calls). Unit tests cover crypto,
  sessions, authorization, sanitizer, error mapping, schemas. Integration tests
  cover the OAuth callback and each tool handler with `ForgejoService` mocked.
- Run a single test: `npm test -- tests/unit/crypto.test.ts`.

## When adding/changing Forgejo behavior

- Add a method to `ForgejoService`, give it a typed return, map errors through the
  shared `ForgejoApiError` so the central error mapper produces a good MCP message.
- If it's a new capability, confirm it fits the security model before exposing it
  as a tool. When in doubt, do NOT expose it.

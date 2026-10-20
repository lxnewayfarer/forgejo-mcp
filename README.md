# Forgejo MCP Server (OAuth)

A production-ready **MCP (Model Context Protocol) server** that lets AI agents
interact with [Forgejo](https://forgejo.org) through a **curated set of 21 tools**.
Every user authenticates with **their own Forgejo account via OAuth 2.0** — no
Personal Access Tokens. The server calls the Forgejo REST API (`/api/v1`) directly.

It is a port of `gitlab-mcp`: same architecture, auth model, storage and audit
trail, with the tool surface mapped onto Forgejo pull requests, reviews and
Forgejo Actions.

```
User → Forgejo OAuth Login → MCP Server → Forgejo REST API
```

## Features

- **Per-user OAuth 2.0** login (PKCE + `state`), token auto-refresh, logout.
- **MCP-client OAuth (zero token paste)** — the server is its own OAuth 2.0
  Authorization Server: Dynamic Client Registration + authorization-code/PKCE,
  with opaque, rotating refresh tokens (reuse detection revokes the whole
  rotation family). Forgejo is the upstream identity provider. Manual bearer-token
  paste remains as a fallback.
- **Server-issued bearer tokens** — the client sends one bearer token; the
  server maps it to that user's Forgejo session.
- **Secure token storage** — Forgejo tokens encrypted at rest (AES-256-GCM);
  session tokens stored only as sha-256 hashes.
- **Strict tool allowlist** — only the 21 tools below; no raw API proxy, no
  admin/destructive operations.
- **Real Forgejo authorization** — every action runs as the authenticated user
  with their own token; repository access is checked before each call.
- **Audit logging** — every tool call recorded in PostgreSQL (secrets stripped).
- **Streamable HTTP MCP transport**, PostgreSQL + Prisma.
- **Docker Compose** one-command deploy. Vitest unit + integration tests.

## The 21 tools

Repositories are addressed by `owner` + `repo`; pull requests by `pull_number`
(the `#N` shown in the UI). Users, reviewers and assignees are usernames.

**Pull requests:** `create_pull_request`, `update_pull_request`,
`get_pull_request`, `list_pull_requests`, `get_pull_request_diff`,
`get_pull_request_shas`.

**Comments & discussions:** `add_comment`, `list_pull_request_discussions`,
`reply_to_review_comment`.

**Review actions:** `assign_reviewer`, `set_labels`, `approve_pull_request`,
`unapprove_pull_request`.

**Forgejo Actions:** `get_workflow_run`, `list_workflow_runs`,
`get_workflow_run_jobs`, `get_job_log`, `retry_job`.

**Repository:** `get_file_content` (read a file at a given ref; read-only).

**User lookup:** `get_current_user`, `find_user`.

### Differences from gitlab-mcp

| gitlab-mcp | forgejo-mcp | Why |
|---|---|---|
| `project_id`, `merge_request_iid` | `owner`, `repo`, `pull_number` | Forgejo addresses repos by owner/name |
| reviewer / assignee IDs | usernames | Forgejo's API takes logins |
| `get_merge_request_versions` | `get_pull_request_shas` | Forgejo has no MR versions; base/head/merge-base SHAs serve the same purpose |
| `reply_to_discussion` | `reply_to_review_comment` | Forgejo threads are inline comments at the same file + line; the reply is posted there |
| `unapprove_merge_request` | `unapprove_pull_request` | No unapprove endpoint: the caller's own approving review is deleted (refused if it carries inline comments) |
| pipelines / jobs | workflow runs / jobs | Forgejo Actions (see version requirements below) |
| `retry_job` (new job id) | `retry_job` (same job id, new attempt) | Forgejo reruns a job as a new attempt of the same job |
| `squash`, `remove_source_branch` | — | Forgejo decides these at merge time |

### Forgejo version requirements

All PR, review, comment, label, file and user tools work on any current
Forgejo (tested live against 13.0). Some Actions tools need newer releases,
checked against the 13.0–17.0 API specs:

| Tool | Minimum Forgejo |
|---|---|
| `get_workflow_run`, `list_workflow_runs` | any supported release |
| `get_workflow_run_jobs`, `get_job_log` | 16 |
| `retry_job` | 17 |

On an older instance these tools return a `not_found` error that names the
instance version and the release required.

## Quick start (Docker)

1. **Create a Forgejo OAuth2 application** (User Settings → Applications →
   *Manage OAuth2 applications*, or at organization / site-admin level). See
   [`docs/oauth.md`](docs/oauth.md) for details.
   - Redirect URI: `http://localhost:3000/auth/callback`
   - Keep **Confidential client** checked.
   - Copy the **Client ID** and **Client Secret**.

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # edit .env: set FORGEJO_BASE_URL (your instance), FORGEJO_CLIENT_ID,
   # FORGEJO_CLIENT_SECRET, FORGEJO_REDIRECT_URI and generate an encryption key:
   openssl rand -hex 32          # paste into ENCRYPTION_KEY
   ```

3. **Run the stack** (Postgres + app, migrations run automatically):
   ```bash
   docker compose up --build
   ```

4. **Log in & get your token:** open <http://localhost:3000/auth/login> in a
   browser, authorize with Forgejo, and copy the **bearer token** shown.

5. **Configure your MCP client** to use the Streamable HTTP endpoint:
   - URL: `http://localhost:3000/mcp`
   - Header: `Authorization: Bearer <your-token>`

   Example (clients supporting remote HTTP MCP servers with headers):
   ```json
   {
     "mcpServers": {
       "forgejo": {
         "type": "http",
         "url": "http://localhost:3000/mcp",
         "headers": { "Authorization": "Bearer <your-token>" }
       }
     }
   }
   ```

To disconnect: `curl -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer <token>"`.

## Local development (without Docker for the app)

```bash
# Start datastores only:
docker compose up -d postgres

cp .env.example .env          # set Forgejo creds + ENCRYPTION_KEY
# point DATABASE_URL at localhost (the defaults already do)

npm install
npm run db:generate
npm run db:migrate            # creates/apply migrations locally
npm run dev                   # http://localhost:3000
```

## Tests

```bash
npm test
```

Forgejo is always mocked — no live calls and no credentials required.

## Documentation

- [Setup guide](docs/setup.md)
- [OAuth configuration guide](docs/oauth.md)
- [Deployment guide](docs/deployment.md)
- [Security review](docs/security.md)
- [Architecture](docs/architecture.md)
- [`CLAUDE.md`](CLAUDE.md) — repo conventions / hard rules for contributors.

## License

MIT

# Architecture

The Forgejo MCP server is a multi-user bridge that lets AI agents (MCP clients)
perform a fixed set of Forgejo operations, each executed as the authenticated
Forgejo user.

## Hard rules

These invariants hold throughout the codebase:

1. **Only `ForgejoService` talks to Forgejo.** All outbound Forgejo REST calls go
   through one service layer (`src/services/forgejoService.ts`).
2. **Only 21 MCP tools exist.** No raw API proxy, no arbitrary calls.
3. **Actions run as the user.** Every call uses the user's own OAuth token; the
   server holds no privileged service token.
4. **Tokens are encrypted at rest** (AES-256-GCM) and never logged.
5. **Everything is audited** with secrets stripped from the recorded parameters.

## Layered architecture

```mermaid
flowchart TD
    subgraph HTTP["http/ — Express edge"]
      Routes["auth routes + /mcp route + /healthz"]
    end
    subgraph MW["middleware/"]
      Auth["bearer auth"]
      Err["error mapping"]
      Audit["audit logging"]
    end
    subgraph MCP["mcp/"]
      Tools["21 tool definitions (Zod schemas)"]
      Handlers["tool handlers"]
    end
    subgraph SVC["services/"]
      FJ["ForgejoService (sole Forgejo caller)"]
    end
    subgraph REPO["repositories/"]
      R["user / oauthAccount / session / auditLog"]
    end
    subgraph DB["database/"]
      PG[("PostgreSQL")]
    end
    subgraph AUTHL["auth/"]
      OAuth["OAuth + PKCE"]
      Sess["session service"]
      Crypto["crypto (AES-256-GCM)"]
      TP["token provider (refresh)"]
    end
    CFG["config/ (env, validated)"]

    Routes --> MW
    MW --> MCP
    Handlers --> FJ
    FJ -->|REST /api/v1 as the user| FJAPI[("Forgejo API")]
    MCP --> REPO
    AUTHL --> REPO
    REPO --> DB
    Routes --> AUTHL
    TP --> OAuth
    Sess --> R
    CFG -.-> SVC
    CFG -.-> AUTHL
```

### Layer responsibilities

| Layer | Responsibility |
|-------|----------------|
| `config/` | Loads and validates environment configuration. |
| `database/` | PostgreSQL (Prisma) client setup. |
| `auth/` | OAuth flow with PKCE, session issuance/validation, AES-256-GCM crypto, and Forgejo token refresh. |
| `services/` | `ForgejoService` — the **only** component that calls the Forgejo REST API (`${FORGEJO_BASE_URL}/api/v1`). |
| `repositories/` | Persistence for users, OAuth accounts, sessions, and audit logs. |
| `mcp/` | The 21 tool definitions (Zod-validated) and their handlers. |
| `middleware/` | Bearer-token authentication, error mapping, and audit logging. |
| `http/` | Express app wiring: `/auth` routes, the `/mcp` endpoint, and `/healthz`. It also mounts the SDK `mcpAuthRouter`, which serves the server's own OAuth Authorization Server endpoints — `/authorize`, `/token`, `/register`, `/revoke`, and the `/.well-known/*` discovery documents — for MCP clients that authenticate via OAuth. |

## OAuth login flow

```mermaid
sequenceDiagram
    actor User
    participant Srv as MCP Server
    participant FJ as Forgejo
    participant DB as PostgreSQL

    User->>Srv: GET /auth/login
    Srv->>DB: store state + PKCE verifier (10-min TTL)
    Srv-->>User: 302 redirect to Forgejo /login/oauth/authorize
    User->>FJ: authorize (approve)
    FJ-->>User: redirect to /auth/callback?code&state
    User->>Srv: GET /auth/callback?code&state
    Srv->>DB: validate + consume state
    Srv->>FJ: POST /login/oauth/access_token (code + secret + PKCE verifier)
    FJ-->>Srv: access + refresh tokens
    Srv->>FJ: GET /api/v1/user
    FJ-->>Srv: user profile
    Srv->>DB: upsert user + store encrypted tokens
    Srv->>DB: create session (store SHA-256 hash)
    Srv-->>User: bearer token (shown once)
```

## MCP tool-call lifecycle

```mermaid
sequenceDiagram
    participant Client as MCP Client
    participant Srv as MCP Server
    participant Auth as bearer auth
    participant TP as token provider
    participant FJ as ForgejoService
    participant API as Forgejo API
    participant DB as PostgreSQL

    Client->>Srv: POST /mcp (Authorization: Bearer <token>, tool call)
    Srv->>Auth: validate bearer (Postgres)
    Auth-->>Srv: resolved user (or 401)
    Srv->>Srv: Zod-validate tool input
    Srv->>TP: get Forgejo access token (refresh if near expiry)
    TP-->>Srv: valid access token
    Srv->>FJ: assertRepoAccess(owner, repo)
    FJ->>API: GET /repos/{owner}/{repo} (as the user)
    API-->>FJ: 200 / 403 / 404
    Srv->>FJ: perform tool action
    FJ->>API: REST call (as the user)
    API-->>FJ: result / error
    Srv->>DB: write AuditLog (sanitized params, status, timing)
    Srv-->>Client: structured result or mapped error
```

End to end: the bearer token is validated and mapped to a user; tool input is
schema-validated; the user's Forgejo token is fetched (and refreshed if needed);
repository access is confirmed (every tool except `get_current_user` and
`find_user`, which are not repository-scoped); the action runs through `ForgejoService` as that
user; and the outcome is recorded in the audit log before the response is
returned. Errors are mapped to safe, meaningful messages along the way.

## Data model

| Model | Purpose |
|-------|---------|
| **User** | A Forgejo user known to the server (Forgejo id, username, name, email). |
| **OAuthAccount** | The user's Forgejo OAuth tokens — access and refresh tokens stored **encrypted** with expiry metadata. |
| **Session** | An issued MCP bearer token, stored as a **SHA-256 hash** with a TTL and revocation state. |
| **AuditLog** | One record per tool invocation: user, Forgejo username, tool name, sanitized parameters, result status, error, and execution time. |

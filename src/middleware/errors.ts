/**
 * Domain error types and a central mapper that turns any thrown error into a
 * meaningful, secret-free message suitable for an MCP tool error response.
 */

export type ErrorKind =
  | "unauthenticated" // no/invalid session
  | "token_expired" // Forgejo token expired/revoked and refresh failed
  | "forbidden" // insufficient Forgejo permissions / no repository access
  | "not_found" // resource not found
  | "rate_limited" // Forgejo 429
  | "upstream_unavailable" // Forgejo 5xx / network failure
  | "bad_request" // malformed input / validation
  | "internal"; // unexpected

export class AppError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Error thrown by ForgejoService when the Forgejo API returns a non-2xx. */
export class ForgejoApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ForgejoApiError";
  }
}

export interface MappedError {
  kind: ErrorKind;
  message: string;
}

/** Map any error into a stable, user-facing MCP error message. */
export function mapError(err: unknown): MappedError {
  if (err instanceof AppError) {
    return { kind: err.kind, message: err.message };
  }

  if (err instanceof ForgejoApiError) {
    switch (true) {
      case err.status === 401:
        return {
          kind: "token_expired",
          message:
            "Forgejo rejected the credentials (401). Your token may be expired or revoked — please log in again at /auth/login.",
        };
      case err.status === 403:
        return {
          kind: "forbidden",
          message:
            "You don't have permission to perform this action on this Forgejo resource (403).",
        };
      case err.status === 404:
        return {
          kind: "not_found",
          message:
            "The requested Forgejo resource was not found, or you don't have access to it (404).",
        };
      case err.status === 429:
        return {
          kind: "rate_limited",
          message: `Forgejo rate limit hit (429).${err.retryAfter ? ` Retry after ~${err.retryAfter}s.` : " Please retry shortly."}`,
        };
      case err.status >= 500:
        return {
          kind: "upstream_unavailable",
          message: `Forgejo is currently unavailable (${err.status}). Please try again later.`,
        };
      default:
        // Do NOT echo the raw Forgejo response body back to the caller — it can
        // contain internal API shape or server-provided content. Log the detail
        // server-side and return only the status.
        console.error(`[forgejo] request failed (${err.status}): ${err.message}`);
        return {
          kind: "bad_request",
          message: `Forgejo rejected the request (${err.status}). Check the parameters and try again.`,
        };
    }
  }

  // Network-level failure reaching Forgejo.
  if (
    err instanceof Error &&
    /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network/i.test(err.message)
  ) {
    return {
      kind: "upstream_unavailable",
      message: "Could not reach Forgejo. The service may be down or unreachable.",
    };
  }

  // Unexpected error: never surface err.message (may contain Prisma/DB/internal
  // detail). Log the real error server-side; return a generic message.
  console.error("[internal error]", err instanceof Error ? err.stack ?? err.message : err);
  return {
    kind: "internal",
    message: "An unexpected error occurred.",
  };
}

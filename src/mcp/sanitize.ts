/**
 * Strip secret-like values from tool params before they are written to the
 * audit log. Two layers:
 *  1. Redact whole values whose KEY looks secret (token, secret, password, …).
 *  2. Redact token patterns found inside string VALUES, so a token a user
 *     pasted into a free-text field (e.g. a PR comment) is not persisted
 *     verbatim. Audit logs are a common exfiltration target.
 *
 * Forgejo personal access tokens are bare 40-char hex strings — the same shape
 * as a commit SHA — so they cannot be told apart on their own. They are caught
 * when they appear in an auth context ("token …", "Bearer …"). Forgejo OAuth2
 * access tokens are JWTs and are caught by shape.
 */
const SECRET_KEY_RE = /(token|secret|password|authorization|api[_-]?key|credential)/i;

// JWT: three base64url segments, header and payload starting with '{"' → "eyJ".
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// A credential following an auth scheme word, e.g. "Authorization: token abc…".
const AUTH_SCHEME_RE = /\b(bearer|token)(\s+)[A-Za-z0-9._~+/-]{20,}=*/gi;
// GitLab-style prefixed tokens (glpat-, gloas-, …) are often pasted around too.
const PREFIXED_TOKEN_RE = /\bgl[a-z]*-[A-Za-z0-9_-]{8,}/g;

const WHOLE_VALUE_RES = [
  /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
  /^gl[a-z]*-[A-Za-z0-9_-]{8,}$/,
];

export function sanitizeParams(input: unknown): unknown {
  if (typeof input === "string") return redactValue(input);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(sanitizeParams);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeParams(v);
    }
  }
  return out;
}

function redactValue(s: string): string {
  // If the whole value is a token, redact it entirely; otherwise scrub matches.
  const trimmed = s.trim();
  if (WHOLE_VALUE_RES.some((re) => re.test(trimmed))) return "[REDACTED]";
  return s
    .replace(JWT_RE, "[REDACTED]")
    .replace(AUTH_SCHEME_RE, "$1$2[REDACTED]")
    .replace(PREFIXED_TOKEN_RE, "[REDACTED]");
}

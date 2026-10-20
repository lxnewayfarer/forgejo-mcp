import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { getConfig } from "../config/index.js";

/**
 * Binds the OAuth `state` to the browser that initiated login, defeating login
 * CSRF: an attacker who feeds a victim a code+state pair cannot complete the
 * callback because the victim's browser never carries the matching cookie.
 *
 * The cookie value is `state.hmac` where hmac is keyed by ENCRYPTION_KEY, so a
 * client cannot forge a cookie for an arbitrary state.
 */
export const STATE_COOKIE = "mcp_oauth_state";

function sign(state: string): string {
  const key = getConfig().encryptionKey;
  return createHmac("sha256", key).update(state).digest("base64url");
}

export function setStateCookie(res: Response, state: string): void {
  const secure = getConfig().PUBLIC_BASE_URL.startsWith("https://");
  res.cookie(STATE_COOKIE, `${state}.${sign(state)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/auth",
    maxAge: 10 * 60 * 1000, // matches the 10-min state TTL
  });
}

export function clearStateCookie(res: Response): void {
  res.clearCookie(STATE_COOKIE, { path: "/auth" });
}

/** True iff the request carries a cookie whose signed state matches `state`. */
export function stateCookieMatches(req: Request, state: string): boolean {
  const raw = parseCookie(req.headers.cookie, STATE_COOKIE);
  if (!raw) return false;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const cookieState = raw.slice(0, dot);
  const cookieSig = raw.slice(dot + 1);
  const expectedSig = sign(state);
  const a = Buffer.from(cookieSig);
  const b = Buffer.from(expectedSig);
  if (cookieState !== state || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

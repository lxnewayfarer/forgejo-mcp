import { describe, it, expect } from "vitest";
import { mapError, AppError, ForgejoApiError } from "../../src/middleware/errors.js";

describe("mapError", () => {
  it("passes AppError kind/message through", () => {
    const e = new AppError("forbidden", "nope");
    expect(mapError(e)).toEqual({ kind: "forbidden", message: "nope" });
  });

  it("maps ForgejoApiError 401 -> token_expired", () => {
    const m = mapError(new ForgejoApiError(401, "unauthorized"));
    expect(m.kind).toBe("token_expired");
    expect(m.message).toMatch(/401/);
  });

  it("maps 403 -> forbidden", () => {
    expect(mapError(new ForgejoApiError(403, "x")).kind).toBe("forbidden");
  });

  it("maps 404 -> not_found", () => {
    expect(mapError(new ForgejoApiError(404, "x")).kind).toBe("not_found");
  });

  it("maps 429 -> rate_limited and includes retryAfter", () => {
    const m = mapError(new ForgejoApiError(429, "slow down", 17));
    expect(m.kind).toBe("rate_limited");
    expect(m.message).toMatch(/17s/);
  });

  it("maps 429 without retryAfter to a generic retry message", () => {
    const m = mapError(new ForgejoApiError(429, "slow down"));
    expect(m.kind).toBe("rate_limited");
    expect(m.message).toMatch(/retry shortly/i);
  });

  it("maps 500 -> upstream_unavailable", () => {
    expect(mapError(new ForgejoApiError(500, "boom")).kind).toBe("upstream_unavailable");
    expect(mapError(new ForgejoApiError(503, "boom")).kind).toBe("upstream_unavailable");
  });

  it("maps other 4xx -> bad_request with the status but WITHOUT echoing the raw body", () => {
    const m = mapError(new ForgejoApiError(422, "secret-ish internal detail"));
    expect(m.kind).toBe("bad_request");
    expect(m.message).toMatch(/422/);
    // The raw Forgejo body must NOT be reflected back to the caller.
    expect(m.message).not.toMatch(/secret-ish internal detail/);
  });

  it("maps network 'fetch failed' Error -> upstream_unavailable", () => {
    expect(mapError(new Error("fetch failed")).kind).toBe("upstream_unavailable");
    expect(mapError(new Error("connect ECONNREFUSED")).kind).toBe("upstream_unavailable");
  });

  it("maps unknown Error -> internal with a GENERIC message (no internal detail leaked)", () => {
    const m = mapError(new Error("Prisma query failed: column users.secret at db.internal"));
    expect(m.kind).toBe("internal");
    expect(m.message).toMatch(/unexpected/i);
    expect(m.message).not.toMatch(/Prisma|db\.internal/);
  });

  it("maps non-Error throw -> internal generic", () => {
    const m = mapError("string thrown");
    expect(m.kind).toBe("internal");
    expect(m.message).toMatch(/unexpected/i);
  });
});

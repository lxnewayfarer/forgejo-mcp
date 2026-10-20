import { describe, it, expect, beforeAll, vi } from "vitest";
import { installTestConfig } from "../helpers/config.js";
import { tokenProvider } from "../../src/auth/tokenProvider.js";
import { AppError } from "../../src/middleware/errors.js";
import type { DecryptedOAuthAccount } from "../../src/repositories/oauthAccountRepository.js";

beforeAll(() => {
  installTestConfig({ TOKEN_REFRESH_SKEW_SECONDS: 60 });
});

function fakeRepo(account: DecryptedOAuthAccount | null) {
  return {
    getDecrypted: vi.fn(async () => account),
    updateTokens: vi.fn(async () => undefined),
  } as any;
}

function account(over: Partial<DecryptedOAuthAccount> = {}): DecryptedOAuthAccount {
  return {
    id: "oa1",
    userId: "u1",
    accessToken: "stored-access",
    refreshToken: "stored-refresh",
    tokenType: "bearer",
    scope: "api",
    expiresAt: null,
    ...over,
  };
}

describe("tokenProvider.getAccessToken", () => {
  it("throws unauthenticated when no account is linked", async () => {
    const tp = tokenProvider({ repo: fakeRepo(null) });
    await expect(tp.getAccessToken("u1")).rejects.toMatchObject({
      kind: "unauthenticated",
    });
  });

  it("returns the stored token when it is not near expiry", async () => {
    const repo = fakeRepo(
      account({ expiresAt: new Date(Date.now() + 3600_000) }),
    );
    const refresh = vi.fn();
    const tp = tokenProvider({ repo, refresh: refresh as any });
    expect(await tp.getAccessToken("u1")).toBe("stored-access");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns the stored token when there is no expiry", async () => {
    const repo = fakeRepo(account({ expiresAt: null }));
    const tp = tokenProvider({ repo });
    expect(await tp.getAccessToken("u1")).toBe("stored-access");
  });

  it("refreshes, persists, and returns a new token when near expiry", async () => {
    const repo = fakeRepo(
      account({ expiresAt: new Date(Date.now() + 10_000) }), // within 60s skew
    );
    const newExp = new Date(Date.now() + 7200_000);
    const refresh = vi.fn(async () => ({
      tokens: {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        token_type: "bearer",
        scope: "api",
      },
      expiresAt: newExp,
    }));
    const tp = tokenProvider({ repo, refresh: refresh as any });

    expect(await tp.getAccessToken("u1")).toBe("fresh-access");
    expect(refresh).toHaveBeenCalledWith("stored-refresh");
    expect(repo.updateTokens).toHaveBeenCalledWith("u1", {
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: newExp,
      scope: "api",
    });
  });

  it("treats an already-expired token as needing refresh", async () => {
    const repo = fakeRepo(account({ expiresAt: new Date(Date.now() - 1000) }));
    const refresh = vi.fn(async () => ({
      tokens: { access_token: "fresh", token_type: "bearer" },
      expiresAt: null,
    }));
    const tp = tokenProvider({ repo, refresh: refresh as any });
    expect(await tp.getAccessToken("u1")).toBe("fresh");
    expect(refresh).toHaveBeenCalled();
  });

  it("throws token_expired when expired and no refresh token exists", async () => {
    const repo = fakeRepo(
      account({ expiresAt: new Date(Date.now() - 1000), refreshToken: null }),
    );
    const tp = tokenProvider({ repo });
    const err = await tp.getAccessToken("u1").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.kind).toBe("token_expired");
  });

  it("throws token_expired when the refresh call fails", async () => {
    const repo = fakeRepo(account({ expiresAt: new Date(Date.now() - 1000) }));
    const refresh = vi.fn(async () => {
      throw new Error("refresh rejected");
    });
    const tp = tokenProvider({ repo, refresh: refresh as any });
    const err = await tp.getAccessToken("u1").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.kind).toBe("token_expired");
  });
});

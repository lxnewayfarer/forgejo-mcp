import { z } from "zod";
import type { PullRequest } from "../../services/forgejoService.js";

/** Repository owner: a user or organization name. */
export const owner = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !s.includes("/"), "owner must not contain '/'")
  .describe("Repository owner (user or organization), e.g. 'trucker'");

/** Repository name (without the owner). */
export const repo = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !s.includes("/"), "repo must not contain '/'")
  .describe("Repository name without the owner, e.g. 'backend'");

export const pullIndex = z
  .number()
  .int()
  .positive()
  .describe("The repository-scoped pull request number (the #N shown in the UI)");

/** A single Forgejo label name. Sent as a JSON array, so commas are fine. */
export const label = z.string().trim().min(1, "label must not be empty");

export const labels = z.array(label);

/** A Forgejo username (login). */
export const username = z.string().trim().min(1).describe("Forgejo username (login)");

export const page = z.number().int().positive().optional();
export const perPage = z.number().int().min(1).max(50).optional().describe("Page size (max 50)");

/**
 * Take the first or last `maxBytes` UTF-8 bytes of a string without splitting a
 * multibyte character at the cut. A cut mid-character leaves a single trailing
 * (for "start") or leading (for "end") U+FFFD replacement char; we drop exactly
 * that one boundary char so we never emit a stray replacement glyph — and never
 * touch replacement chars that were genuinely in the source.
 *
 * Returns the slice plus whether anything was cut, and operates on a Buffer the
 * caller can pass in to avoid re-encoding the same string twice.
 */
export function sliceByBytes(
  text: string,
  maxBytes: number,
  from: "start" | "end",
  buf: Buffer = Buffer.from(text, "utf-8"),
): { slice: string; truncated: boolean } {
  if (buf.length <= maxBytes) return { slice: text, truncated: false };
  const cut = from === "end" ? buf.subarray(buf.length - maxBytes) : buf.subarray(0, maxBytes);
  let slice = cut.toString("utf-8");
  // Strip at most one boundary replacement char (the partial multibyte char the
  // byte cut produced), not a run — a leading/trailing U+FFFD already in the
  // source must survive.
  if (from === "end" && slice.startsWith("�")) slice = slice.slice(1);
  else if (from === "start" && slice.endsWith("�")) slice = slice.slice(0, -1);
  return { slice, truncated: true };
}

/** Forgejo reports merged PRs as state "closed" + merged:true; surface "merged". */
export function pullState(pr: Pick<PullRequest, "state" | "merged">): string {
  return pr.merged ? "merged" : pr.state;
}

/** Compact PR shape returned to the agent. */
export function presentPullRequest(pr: PullRequest) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    description: pr.body ?? null,
    state: pullState(pr),
    draft: pr.draft ?? false,
    url: pr.html_url,
    source_branch: pr.head?.ref,
    target_branch: pr.base?.ref,
    author: pr.user?.login ?? null,
    labels: (pr.labels ?? []).map((l) => l.name),
    assignees: (pr.assignees ?? []).map((a) => ({ id: a.id, username: a.login })),
    reviewers: (pr.requested_reviewers ?? []).map((r) => ({ id: r.id, username: r.login })),
    mergeable: pr.mergeable ?? null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

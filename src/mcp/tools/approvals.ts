import { z } from "zod";
import { defineTool } from "../types.js";
import { AppError } from "../../middleware/errors.js";
import { owner, repo, pullIndex } from "./common.js";

export const approvePullRequest = defineTool({
  name: "approve_pull_request",
  description:
    "Approve a pull request as the authenticated user (submits an APPROVED review). Approving your own pull request is not allowed and returns a forbidden error.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
    body: z.string().optional().describe("Optional approval message"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    // Forgejo answers a self-approval with a bare 422; say what's wrong instead.
    const pr = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    if (pr.user?.id === ctx.auth.forgejoUserId) {
      throw new AppError("forbidden", "You cannot approve your own pull request.");
    }
    const review = await ctx.forgejo.createReview(input.owner, input.repo, input.pull_number, {
      event: "APPROVED",
      body: input.body ?? "",
    });
    return {
      approved: review.state === "APPROVED",
      review_id: review.id,
      approved_by: review.user?.login ?? ctx.auth.username,
    };
  },
});

export const unapprovePullRequest = defineTool({
  name: "unapprove_pull_request",
  description:
    "Revoke the authenticated user's approval of a pull request by deleting their approving review. Refuses if that review carries inline comments (deleting it would delete them too).",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const me = await ctx.forgejo.getCurrentUser();
    const reviews = await ctx.forgejo.listReviews(input.owner, input.repo, input.pull_number);
    const approvals = reviews.filter(
      (r) => r.user?.id === me.id && r.state === "APPROVED" && !r.dismissed,
    );
    if (approvals.length === 0) {
      throw new AppError("not_found", "You have no active approval on this pull request.");
    }
    const withComments = approvals.filter((r) => r.comments_count > 0);
    if (withComments.length > 0) {
      throw new AppError(
        "bad_request",
        `Your approving review #${withComments[0].id} has inline comments; deleting it would delete them. Revoke it in the Forgejo UI instead (e.g. submit a "Request changes" review or ask a maintainer to dismiss it).`,
      );
    }
    for (const r of approvals) {
      await ctx.forgejo.deleteReview(input.owner, input.repo, input.pull_number, r.id);
    }
    return { unapproved: true, deleted_review_ids: approvals.map((r) => r.id) };
  },
});

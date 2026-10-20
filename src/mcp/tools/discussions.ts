import { z } from "zod";
import { defineTool } from "../types.js";
import { ForgejoApiError } from "../../middleware/errors.js";
import type { ReviewComment } from "../../services/forgejoService.js";
import { owner, repo, pullIndex } from "./common.js";

/** Which side of the diff an inline comment sits on, and at which line. */
function anchorOf(c: ReviewComment): { side: "new" | "old"; line: number } {
  return c.position > 0
    ? { side: "new", line: c.position }
    : { side: "old", line: c.original_position };
}

export const listPullRequestDiscussions = defineTool({
  name: "list_pull_request_discussions",
  description:
    "List existing discussion on a pull request (for dedup before commenting): conversation comments, submitted reviews, and inline review threads grouped by file + line. Reply to a thread with reply_to_review_comment using its reply_to ids.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const [comments, reviews] = await Promise.all([
      ctx.forgejo.listComments(input.owner, input.repo, input.pull_number),
      ctx.forgejo.listReviews(input.owner, input.repo, input.pull_number),
    ]);
    // REQUEST_REVIEW entries are pending review requests, not content.
    const submitted = reviews.filter((r) => r.state !== "REQUEST_REVIEW");
    const reviewComments = (
      await Promise.all(
        submitted
          .filter((r) => r.comments_count > 0)
          .map((r) => ctx.forgejo.listReviewComments(input.owner, input.repo, input.pull_number, r.id)),
      )
    ).flat();

    // Forgejo renders inline comments on the same file/side/line as one
    // conversation, regardless of which review they were submitted in.
    const threads = new Map<string, ReviewComment[]>();
    for (const c of reviewComments.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const { side, line } = anchorOf(c);
      const key = `${c.path}\u0000${side}\u0000${line}`;
      const list = threads.get(key) ?? [];
      list.push(c);
      threads.set(key, list);
    }

    return {
      comments: comments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? null,
        body: c.body,
        created_at: c.created_at,
      })),
      reviews: submitted.map((r) => ({
        id: r.id,
        state: r.state,
        author: r.user?.login ?? null,
        body: r.body,
        commit_id: r.commit_id,
        stale: r.stale,
        dismissed: r.dismissed,
        submitted_at: r.submitted_at,
      })),
      threads: [...threads.values()].map((notes) => {
        const first = notes[0];
        const last = notes[notes.length - 1];
        return {
          path: first.path,
          ...anchorOf(first),
          resolved: notes.some((n) => n.resolver != null),
          reply_to: { review_id: last.pull_request_review_id, comment_id: last.id },
          notes: notes.map((n) => ({
            id: n.id,
            review_id: n.pull_request_review_id,
            author: n.user?.login ?? null,
            body: n.body,
            commit_id: n.commit_id,
            created_at: n.created_at,
          })),
        };
      }),
    };
  },
});

export const replyToReviewComment = defineTool({
  name: "reply_to_review_comment",
  description:
    "Reply to an existing inline review thread on a pull request. Pass the review_id and comment_id from a thread's reply_to (list_pull_request_discussions). The reply is posted at the same file and line, so Forgejo shows it in the same conversation.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
    review_id: z.number().int().positive(),
    comment_id: z.number().int().positive(),
    body: z.string().min(1),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const comments = await ctx.forgejo.listReviewComments(
      input.owner,
      input.repo,
      input.pull_number,
      input.review_id,
    );
    const target = comments.find((c) => c.id === input.comment_id);
    if (!target) {
      throw new ForgejoApiError(404, "No such inline comment in that review.");
    }
    const { side, line } = anchorOf(target);
    const review = await ctx.forgejo.createReview(input.owner, input.repo, input.pull_number, {
      event: "COMMENT",
      body: "",
      commit_id: target.commit_id,
      comments: [
        {
          path: target.path,
          body: input.body,
          ...(side === "new" ? { new_position: line } : { old_position: line }),
        },
      ],
    });
    return { review_id: review.id };
  },
});

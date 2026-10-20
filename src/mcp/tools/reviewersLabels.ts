import { z } from "zod";
import { defineTool } from "../types.js";
import { owner, repo, pullIndex, presentPullRequest, labels as labelsSchema, username } from "./common.js";

export const assignReviewer = defineTool({
  name: "assign_reviewer",
  description:
    "Set the requested reviewers of a pull request (replaces pending review requests: new usernames are requested, ones not listed are cancelled).",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
    reviewers: z.array(username).min(1).describe("Reviewer usernames"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const pr = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    const wanted = new Set(input.reviewers.map((r) => r.toLowerCase()));
    const current = (pr.requested_reviewers ?? []).map((r) => r.login);
    const currentSet = new Set(current.map((r) => r.toLowerCase()));

    const toAdd = input.reviewers.filter((r) => !currentSet.has(r.toLowerCase()));
    const toRemove = current.filter((r) => !wanted.has(r.toLowerCase()));
    if (toAdd.length) {
      await ctx.forgejo.requestReviewers(input.owner, input.repo, input.pull_number, toAdd);
    }
    if (toRemove.length) {
      await ctx.forgejo.cancelReviewRequests(input.owner, input.repo, input.pull_number, toRemove);
    }
    const updated = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    return presentPullRequest(updated);
  },
});

export const setLabels = defineTool({
  name: "set_labels",
  description:
    "Set the labels of a pull request by name (replaces existing labels). Labels must already exist in the repository or its organization; check the returned labels to confirm every name matched.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
    labels: labelsSchema,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    await ctx.forgejo.replaceLabels(input.owner, input.repo, input.pull_number, input.labels);
    const pr = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    return presentPullRequest(pr);
  },
});

import { z } from "zod";
import { defineTool } from "../types.js";
import { owner, repo, pullIndex } from "./common.js";

export const getPullRequestDiff = defineTool({
  name: "get_pull_request_diff",
  description: "Get the full per-file diff of a pull request for change analysis.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const files = await ctx.forgejo.getPullRequestDiff(input.owner, input.repo, input.pull_number);
    return { files };
  },
});

export const getPullRequestShas = defineTool({
  name: "get_pull_request_shas",
  description:
    "Get the commit SHAs of a pull request: base (target branch tip), head (source branch tip) and merge base. Use head_sha as the commit for inline review comments.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const pr = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    return {
      base_sha: pr.base.sha,
      head_sha: pr.head.sha,
      merge_base_sha: pr.merge_base ?? null,
    };
  },
});

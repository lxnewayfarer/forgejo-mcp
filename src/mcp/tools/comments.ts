import { z } from "zod";
import { defineTool } from "../types.js";
import { owner, repo, pullIndex } from "./common.js";

export const addComment = defineTool({
  name: "add_comment",
  description: "Add a comment to a pull request's conversation.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
    comment: z.string().min(1),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const c = await ctx.forgejo.addComment(input.owner, input.repo, input.pull_number, input.comment);
    return {
      id: c.id,
      body: c.body,
      author: c.user?.login ?? null,
      url: c.html_url ?? null,
      created_at: c.created_at,
    };
  },
});

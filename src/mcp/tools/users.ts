import { z } from "zod";
import { defineTool } from "../types.js";
import { username } from "./common.js";

export const getCurrentUser = defineTool({
  name: "get_current_user",
  description: "Return the authenticated Forgejo user (for self-review detection).",
  schema: z.object({}),
  async handler(_input, ctx) {
    const u = await ctx.forgejo.getCurrentUser();
    return { id: u.id, username: u.login, name: u.full_name || u.login };
  },
});

export const findUser = defineTool({
  name: "find_user",
  description:
    "Look up a Forgejo user by username (confirms the account exists and returns its id). Returns null if no user matches.",
  schema: z.object({
    username,
  }),
  async handler(input, ctx) {
    const u = await ctx.forgejo.findUserByUsername(input.username);
    return u ? { id: u.id, username: u.login, name: u.full_name || u.login } : null;
  },
});

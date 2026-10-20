import { z } from "zod";
import { defineTool } from "../types.js";
import { owner, repo, sliceByBytes } from "./common.js";

const FILE_MAX_BYTES = 1024 * 1024; // 1 MiB

export const getFileContent = defineTool({
  name: "get_file_content",
  description:
    "Read a repository file's content at a given ref (branch, tag, or commit SHA). Text files return encoding:'text'; binary files return encoding:'base64' (content is base64). Content over 1 MiB is truncated (truncated=true).",
  schema: z.object({
    owner,
    repo,
    file_path: z.string().min(1).describe("Path to the file within the repository, e.g. 'src/app.ts'"),
    ref: z.string().min(1).describe("Branch, tag, or commit SHA"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const file = await ctx.forgejo.getFile(input.owner, input.repo, input.file_path, input.ref);
    const { slice, truncated } = sliceByBytes(file.content, FILE_MAX_BYTES, "start");
    return {
      file_path: file.file_path,
      ref: file.ref,
      size: file.size,
      encoding: file.encoding,
      blob_id: file.blob_id,
      last_commit_sha: file.last_commit_sha,
      content: slice,
      truncated,
    };
  },
});

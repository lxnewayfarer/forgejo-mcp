import { z } from "zod";
import { defineTool } from "../types.js";
import { AppError, mapError } from "../../middleware/errors.js";
import type { PullRequest } from "../../services/forgejoService.js";
import {
  owner,
  repo,
  pullIndex,
  presentPullRequest,
  labels as labelsSchema,
  username,
  page,
  perPage,
} from "./common.js";

/**
 * Run a follow-up step after the PR already exists. A failure must not hide
 * that the PR was created, so the error names the PR it left behind.
 */
async function afterCreate(pr: PullRequest, what: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    const mapped = mapError(err);
    throw new AppError(
      mapped.kind,
      `Pull request #${pr.number} was created (${pr.html_url}), but ${what} failed: ${mapped.message}`,
    );
  }
}

export const createPullRequest = defineTool({
  name: "create_pull_request",
  description:
    "Create a pull request in a Forgejo repository on behalf of the authenticated user, optionally with labels, assignees and requested reviewers.",
  schema: z.object({
    owner,
    repo,
    source_branch: z
      .string()
      .min(1)
      .describe("Head branch with the changes (use 'fork-owner:branch' for a branch in a fork)"),
    target_branch: z.string().min(1).describe("Base branch to merge into"),
    title: z.string().min(1),
    description: z.string().optional(),
    labels: labelsSchema.optional().describe("Label names; they must already exist in the repository"),
    assignees: z.array(username).optional().describe("Assignee usernames"),
    reviewers: z.array(username).optional().describe("Reviewer usernames to request a review from"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const pr = await ctx.forgejo.createPullRequest(input.owner, input.repo, {
      head: input.source_branch,
      base: input.target_branch,
      title: input.title,
      body: input.description,
      assignees: input.assignees,
    });
    if (input.labels?.length) {
      await afterCreate(pr, "setting labels", () =>
        ctx.forgejo.replaceLabels(input.owner, input.repo, pr.number, input.labels!),
      );
    }
    if (input.reviewers?.length) {
      await afterCreate(pr, "requesting reviewers", () =>
        ctx.forgejo.requestReviewers(input.owner, input.repo, pr.number, input.reviewers!),
      );
    }
    return { url: pr.html_url, id: pr.id, number: pr.number, status: pr.state };
  },
});

export const updatePullRequest = defineTool({
  name: "update_pull_request",
  description: "Update fields of an existing pull request (title, description, labels, assignees).",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    labels: labelsSchema.optional().describe("Replaces all labels; names must exist in the repository"),
    assignees: z.array(username).optional().describe("Replaces all assignees"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const fields = {
      title: input.title,
      body: input.description,
      assignees: input.assignees,
    };
    const hasFields = Object.values(fields).some((v) => v !== undefined);
    if (hasFields) {
      await ctx.forgejo.updatePullRequest(input.owner, input.repo, input.pull_number, fields);
    }
    if (input.labels !== undefined) {
      await ctx.forgejo.replaceLabels(input.owner, input.repo, input.pull_number, input.labels);
    }
    const pr = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    return presentPullRequest(pr);
  },
});

export const getPullRequest = defineTool({
  name: "get_pull_request",
  description: "Get details of a single pull request.",
  schema: z.object({
    owner,
    repo,
    pull_number: pullIndex,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const pr = await ctx.forgejo.getPullRequest(input.owner, input.repo, input.pull_number);
    return presentPullRequest(pr);
  },
});

export const listPullRequests = defineTool({
  name: "list_pull_requests",
  description:
    "List pull requests in a repository, with optional filters and pagination. Merged PRs are returned under state 'closed' (shown as state 'merged').",
  schema: z.object({
    owner,
    repo,
    state: z.enum(["open", "closed", "all"]).optional(),
    author: z.string().optional().describe("Filter by author username"),
    target_branch: z.string().optional().describe("Filter by base branch"),
    source_branch: z.string().optional().describe("Filter by head branch"),
    page,
    per_page: perPage,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const result = await ctx.forgejo.listPullRequests(input.owner, input.repo, {
      state: input.state,
      poster: input.author,
      base: input.target_branch,
      head: input.source_branch,
      page: input.page,
      perPage: input.per_page,
    });
    return {
      items: result.items.map(presentPullRequest),
      pagination: result.pagination,
    };
  },
});

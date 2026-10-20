import type { ToolDefinition } from "./types.js";
import {
  createPullRequest,
  updatePullRequest,
  getPullRequest,
  listPullRequests,
} from "./tools/pullRequests.js";
import { addComment } from "./tools/comments.js";
import { getWorkflowRun, listWorkflowRuns, getWorkflowRunJobs, getJobLog, retryJob } from "./tools/actions.js";
import { getFileContent } from "./tools/files.js";
import { assignReviewer, setLabels } from "./tools/reviewersLabels.js";
import { getCurrentUser, findUser } from "./tools/users.js";
import { getPullRequestDiff, getPullRequestShas } from "./tools/diffs.js";
import { listPullRequestDiscussions, replyToReviewComment } from "./tools/discussions.js";
import { approvePullRequest, unapprovePullRequest } from "./tools/approvals.js";

/**
 * The complete, intentionally-curated tool surface (21 tools). Nothing outside
 * this list is exposed — no raw API proxy, no admin/destructive operations.
 * Read + diff + discussion-reply + approve operations on pull requests,
 * Actions run/job/log and file inspection plus job retry, and bounded user lookup.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDefinition<any>[] = [
  createPullRequest,
  updatePullRequest,
  getPullRequest,
  listPullRequests,
  addComment,
  getWorkflowRun,
  listWorkflowRuns,
  getWorkflowRunJobs,
  getJobLog,
  retryJob,
  getFileContent,
  assignReviewer,
  setLabels,
  getCurrentUser,
  findUser,
  getPullRequestDiff,
  getPullRequestShas,
  listPullRequestDiscussions,
  replyToReviewComment,
  approvePullRequest,
  unapprovePullRequest,
];

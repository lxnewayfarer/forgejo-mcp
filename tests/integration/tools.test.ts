import { describe, it, expect, beforeAll, vi } from "vitest";
import { installTestConfig } from "../helpers/config.js";
import {
  createPullRequest,
  updatePullRequest,
  getPullRequest,
  listPullRequests,
} from "../../src/mcp/tools/pullRequests.js";
import { addComment } from "../../src/mcp/tools/comments.js";
import { getWorkflowRun, listWorkflowRuns, getWorkflowRunJobs, getJobLog, retryJob } from "../../src/mcp/tools/actions.js";
import { getFileContent } from "../../src/mcp/tools/files.js";
import { assignReviewer, setLabels } from "../../src/mcp/tools/reviewersLabels.js";
import { getCurrentUser as getCurrentUserTool, findUser } from "../../src/mcp/tools/users.js";
import { getPullRequestDiff, getPullRequestShas } from "../../src/mcp/tools/diffs.js";
import { listPullRequestDiscussions, replyToReviewComment } from "../../src/mcp/tools/discussions.js";
import { approvePullRequest, unapprovePullRequest } from "../../src/mcp/tools/approvals.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { ForgejoApiError, mapError } from "../../src/middleware/errors.js";
import type { AuthContext, ToolContext } from "../../src/mcp/types.js";
import { TOOLS } from "../../src/mcp/registry.js";

beforeAll(() => installTestConfig());

const auth: AuthContext = { userId: "u1", forgejoUserId: 99, username: "alice" };

const PR = {
  id: 100,
  number: 5,
  title: "T",
  body: "D",
  state: "open",
  draft: false,
  html_url: "https://fj/o/r/pulls/5",
  head: { label: "feat", ref: "feat", sha: "head1" },
  base: { label: "main", ref: "main", sha: "base1" },
  merge_base: "mb1",
  labels: [{ id: 1, name: "bug" }],
  user: { id: 99, login: "alice" },
  assignees: [{ id: 1, login: "bob" }],
  requested_reviewers: [{ id: 2, login: "carol" }],
  mergeable: true,
  merged: false,
  created_at: "c",
  updated_at: "u",
};

const RUN = {
  id: 55,
  index_in_repo: 12,
  title: "CI",
  status: "success",
  event: "push",
  workflow_id: "ci.yml",
  prettyref: "main",
  commit_sha: "abc",
  html_url: "https://fj/o/r/actions/runs/12",
  duration: 42_000_000_000,
  created: "c",
  updated: "u",
  started: "s",
  stopped: "0001-01-01T00:00:00Z",
};

const JOB = { id: 200, run_id: 55, name: "build", status: "failure", attempt: 1, needs: null, runs_on: ["docker"], task_id: 9 };

const COMMENT = { id: 11, body: "hi", user: { id: 2, login: "carol" }, html_url: "https://fj/c/11", created_at: "c" };

const page1 = (n: number) => ({ page: 1, perPage: 20, total: n, totalPages: 1, nextPage: null });

/** A ForgejoService stub that records calls and asserts access-check ordering. */
function makeStub() {
  const rec = <T>(value: T) => vi.fn(async (..._args: unknown[]) => value);
  const stub = {
    assertRepoAccess: rec(undefined),
    createPullRequest: rec(PR),
    updatePullRequest: rec(PR),
    getPullRequest: rec(PR),
    listPullRequests: rec({ items: [PR], pagination: page1(1) }),
    replaceLabels: rec([{ id: 1, name: "bug" }]),
    requestReviewers: rec(undefined),
    cancelReviewRequests: rec(undefined),
    getPullRequestDiff: rec([
      { old_path: "a", new_path: "a", diff: "@@", new_file: false, renamed_file: false, deleted_file: false },
    ]),
    addComment: rec(COMMENT),
    listComments: rec([COMMENT]),
    listReviews: rec([] as unknown[]),
    listReviewComments: rec([] as unknown[]),
    createReview: rec({ id: 77, state: "APPROVED", user: { id: 99, login: "alice" } }),
    deleteReview: rec(undefined),
    getCurrentUser: rec({ id: 99, login: "alice", full_name: "Alice" }),
    findUserByUsername: rec({ id: 2, login: "carol", full_name: "" } as unknown),
    getWorkflowRun: rec(RUN),
    listWorkflowRuns: rec({ items: [RUN], pagination: page1(1) }),
    listWorkflowRunJobs: rec([JOB]),
    getJobLog: rec("log"),
    getWorkflowJob: rec({ ...JOB, status: "waiting", attempt: 2, html_url: "https://fj/o/r/actions/runs/12/jobs/0" }),
    rerunJob: rec(undefined),
    getVersion: rec("17.0.0+gitea-1.22.0"),
    getFile: rec({
      file_path: "src/a.ts",
      size: 5,
      encoding: "text",
      content: "hello",
      blob_id: "b1",
      last_commit_sha: "c1",
      ref: "main",
    }),
  };
  // Call order is derived from vitest's global invocation order, so per-test
  // overrides (mockResolvedValueOnce etc.) are still recorded.
  return { stub, calls: () => callOrder(stub) };
}

function callOrder(stub: Record<string, ReturnType<typeof vi.fn>>): string[] {
  return Object.entries(stub)
    .flatMap(([name, fn]) => fn.mock.invocationCallOrder.map((order) => ({ name, order })))
    .sort((a, b) => a.order - b.order)
    .map((c) => c.name);
}

function ctxWith(stub: unknown): ToolContext {
  return { auth, forgejo: stub as any };
}

const where = { owner: "o", repo: "r" };

describe("MCP tool handlers", () => {
  it("create_pull_request: access first, creates, then sets labels and reviewers", async () => {
    const { stub, calls } = makeStub();
    const out = await createPullRequest.handler(
      {
        ...where,
        source_branch: "feat",
        target_branch: "main",
        title: "T",
        description: "D",
        labels: ["bug"],
        assignees: ["bob"],
        reviewers: ["carol"],
      },
      ctxWith(stub),
    );
    expect(calls()).toEqual(["assertRepoAccess", "createPullRequest", "replaceLabels", "requestReviewers"]);
    expect(stub.createPullRequest).toHaveBeenCalledWith("o", "r", {
      head: "feat",
      base: "main",
      title: "T",
      body: "D",
      assignees: ["bob"],
    });
    expect(stub.replaceLabels).toHaveBeenCalledWith("o", "r", 5, ["bug"]);
    expect(stub.requestReviewers).toHaveBeenCalledWith("o", "r", 5, ["carol"]);
    expect(out).toEqual({ url: PR.html_url, id: 100, number: 5, status: "open" });
  });

  it("create_pull_request: skips label/reviewer calls when none given", async () => {
    const { stub, calls } = makeStub();
    await createPullRequest.handler(
      { ...where, source_branch: "feat", target_branch: "main", title: "T" },
      ctxWith(stub),
    );
    expect(calls()).toEqual(["assertRepoAccess", "createPullRequest"]);
  });

  it("create_pull_request: a failed follow-up names the PR that was created", async () => {
    const { stub } = makeStub();
    stub.replaceLabels.mockRejectedValueOnce(new ForgejoApiError(403, "no"));
    const err = await createPullRequest
      .handler(
        { ...where, source_branch: "feat", target_branch: "main", title: "T", labels: ["x"] },
        ctxWith(stub),
      )
      .catch((e) => e);
    const mapped = mapError(err);
    expect(mapped.kind).toBe("forbidden");
    expect(mapped.message).toContain("Pull request #5 was created (https://fj/o/r/pulls/5)");
    expect(mapped.message).toContain("setting labels failed");
  });

  it("update_pull_request: patches fields, replaces labels, returns the fresh PR", async () => {
    const { stub, calls } = makeStub();
    const out: any = await updatePullRequest.handler(
      { ...where, pull_number: 5, title: "T2", labels: [] },
      ctxWith(stub),
    );
    expect(calls()).toEqual(["assertRepoAccess", "updatePullRequest", "replaceLabels", "getPullRequest"]);
    expect(stub.updatePullRequest).toHaveBeenCalledWith("o", "r", 5, {
      title: "T2",
      body: undefined,
      assignees: undefined,
    });
    expect(stub.replaceLabels).toHaveBeenCalledWith("o", "r", 5, []);
    expect(out.url).toBe(PR.html_url);
  });

  it("update_pull_request: labels-only update does not PATCH", async () => {
    const { stub, calls } = makeStub();
    await updatePullRequest.handler({ ...where, pull_number: 5, labels: ["bug"] }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "replaceLabels", "getPullRequest"]);
  });

  it("get_pull_request: presents the PR compactly", async () => {
    const { stub } = makeStub();
    const out: any = await getPullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(stub.getPullRequest).toHaveBeenCalledWith("o", "r", 5);
    expect(out).toEqual({
      id: 100,
      number: 5,
      title: "T",
      description: "D",
      state: "open",
      draft: false,
      url: PR.html_url,
      source_branch: "feat",
      target_branch: "main",
      author: "alice",
      labels: ["bug"],
      assignees: [{ id: 1, username: "bob" }],
      reviewers: [{ id: 2, username: "carol" }],
      mergeable: true,
      created_at: "c",
      updated_at: "u",
    });
  });

  it("get_pull_request: reports merged PRs as state 'merged'", async () => {
    const { stub } = makeStub();
    stub.getPullRequest.mockResolvedValueOnce({ ...PR, state: "closed", merged: true });
    const out: any = await getPullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(out.state).toBe("merged");
  });

  it("list_pull_requests: maps filters and returns items+pagination", async () => {
    const { stub } = makeStub();
    const out: any = await listPullRequests.handler(
      { ...where, state: "open", author: "alice", target_branch: "main", page: 2, per_page: 10 },
      ctxWith(stub),
    );
    expect(stub.listPullRequests).toHaveBeenCalledWith("o", "r", {
      state: "open",
      poster: "alice",
      base: "main",
      head: undefined,
      page: 2,
      perPage: 10,
    });
    expect(out.items[0].number).toBe(5);
    expect(out.pagination.total).toBe(1);
  });

  it("add_comment: posts and returns the comment", async () => {
    const { stub, calls } = makeStub();
    const out = await addComment.handler({ ...where, pull_number: 5, comment: "hi" }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "addComment"]);
    expect(stub.addComment).toHaveBeenCalledWith("o", "r", 5, "hi");
    expect(out).toEqual({ id: 11, body: "hi", author: "carol", url: "https://fj/c/11", created_at: "c" });
  });

  it("get_workflow_run: returns status, seconds duration, null for zero timestamps", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getWorkflowRun.handler({ ...where, run_id: 55 }, ctxWith(stub));
    expect(calls()[0]).toBe("assertRepoAccess");
    expect(out).toMatchObject({
      id: 55,
      run_number: 12,
      status: "success",
      url: RUN.html_url,
      duration_seconds: 42,
      started_at: "s",
      finished_at: null,
    });
  });

  it("list_workflow_runs: expands a bare branch to refs/heads/", async () => {
    const { stub } = makeStub();
    const out: any = await listWorkflowRuns.handler(
      { ...where, branch: "main", status: "failure" },
      ctxWith(stub),
    );
    expect(stub.listWorkflowRuns).toHaveBeenCalledWith("o", "r", {
      ref: "refs/heads/main",
      status: "failure",
      event: undefined,
      page: undefined,
      perPage: undefined,
    });
    expect(out.items[0]).toMatchObject({ id: 55, sha: "abc" });
  });

  it("list_workflow_runs: passes a full ref through untouched", async () => {
    const { stub } = makeStub();
    await listWorkflowRuns.handler({ ...where, branch: "refs/tags/v1" }, ctxWith(stub));
    expect(stub.listWorkflowRuns.mock.calls[0][2]).toMatchObject({ ref: "refs/tags/v1" });
  });

  it("get_workflow_run_jobs: access first, compact fields", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getWorkflowRunJobs.handler({ ...where, run_id: 55 }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "listWorkflowRunJobs"]);
    expect(out.items).toEqual([
      { id: 200, name: "build", status: "failure", attempt: 1, needs: [], runs_on: ["docker"] },
    ]);
  });

  it("get_job_log: strips ANSI/CR, returns tail by default with byte accounting", async () => {
    const { stub } = makeStub();
    stub.getJobLog.mockResolvedValueOnce("\x1b[31mred\x1b[0m line\r\nok\n");
    const out: any = await getJobLog.handler({ ...where, job_id: 200, attempt: 2 }, ctxWith(stub));
    expect(stub.getJobLog).toHaveBeenCalledWith("o", "r", 200, 2);
    expect(out).toEqual({
      log: "red line\nok\n",
      from: "end",
      truncated: false,
      returned_bytes: 12,
      total_bytes: 12,
    });
  });

  it("get_job_log: from='start' returns the head slice and marks truncation", async () => {
    const { stub } = makeStub();
    stub.getJobLog.mockResolvedValueOnce("abcdefghij");
    const out: any = await getJobLog.handler(
      { ...where, job_id: 1, tail_bytes: 4, from: "start" },
      ctxWith(stub),
    );
    expect(out.log).toBe("abcd");
    expect(out.truncated).toBe(true);
    expect(out.total_bytes).toBe(10);
  });

  it("get_job_log: from='end' returns the tail slice", async () => {
    const { stub } = makeStub();
    stub.getJobLog.mockResolvedValueOnce("abcdefghij");
    const out: any = await getJobLog.handler({ ...where, job_id: 1, tail_bytes: 3 }, ctxWith(stub));
    expect(out.log).toBe("hij");
  });

  it("retry_job: reruns, then returns the job's new attempt", async () => {
    const { stub, calls } = makeStub();
    const out = await retryJob.handler({ ...where, job_id: 200 }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "rerunJob", "getWorkflowJob"]);
    expect(stub.rerunJob).toHaveBeenCalledWith("o", "r", 200);
    expect(out).toEqual({
      id: 200,
      run_id: 55,
      name: "build",
      status: "waiting",
      attempt: 2,
      url: "https://fj/o/r/actions/runs/12/jobs/0",
    });
  });

  it("Actions tools explain a 404 from an instance too old for the endpoint", async () => {
    const cases = [
      { tool: getWorkflowRunJobs, method: "listWorkflowRunJobs", args: { run_id: 1 }, version: "15.0.10+gitea-1.22.0", need: 16 },
      { tool: getJobLog, method: "getJobLog", args: { job_id: 1 }, version: "13.0.5+gitea-1.22.0", need: 16 },
      { tool: retryJob, method: "rerunJob", args: { job_id: 1 }, version: "16.0.6+gitea-1.22.0", need: 17 },
    ] as const;
    for (const c of cases) {
      const { stub } = makeStub();
      (stub as any)[c.method].mockRejectedValueOnce(new ForgejoApiError(404, "Not Found"));
      stub.getVersion.mockResolvedValueOnce(c.version);
      const err = await (c.tool.handler as any)({ ...where, ...c.args }, ctxWith(stub)).catch((e: unknown) => e);
      const mapped = mapError(err);
      expect(mapped.kind).toBe("not_found");
      expect(mapped.message).toContain(`version ${c.version}`);
      expect(mapped.message).toContain(`Forgejo ${c.need} or newer is required`);
    }
  });

  it("Actions tools keep a plain not_found on a new-enough instance", async () => {
    const { stub } = makeStub();
    stub.getJobLog.mockRejectedValueOnce(new ForgejoApiError(404, "Not Found"));
    stub.getVersion.mockResolvedValueOnce("16.0.6+gitea-1.22.0");
    const err = await getJobLog.handler({ ...where, job_id: 999 }, ctxWith(stub)).catch((e) => e);
    expect(err).toBeInstanceOf(ForgejoApiError);
    expect(mapError(err).message).toMatch(/not found/);
  });

  it("Actions tools pass non-404 errors straight through", async () => {
    const { stub } = makeStub();
    stub.rerunJob.mockRejectedValueOnce(new ForgejoApiError(403, "no"));
    const err = await retryJob.handler({ ...where, job_id: 1 }, ctxWith(stub)).catch((e) => e);
    expect(mapError(err).kind).toBe("forbidden");
    expect(stub.getVersion).not.toHaveBeenCalled();
  });

  it("get_file_content: access first, returns content + metadata", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getFileContent.handler(
      { ...where, file_path: "src/a.ts", ref: "main" },
      ctxWith(stub),
    );
    expect(calls()).toEqual(["assertRepoAccess", "getFile"]);
    expect(stub.getFile).toHaveBeenCalledWith("o", "r", "src/a.ts", "main");
    expect(out).toMatchObject({ content: "hello", truncated: false, blob_id: "b1", last_commit_sha: "c1" });
  });

  it("get_file_content: truncates content over the 1 MiB cap", async () => {
    const { stub } = makeStub();
    const big = "x".repeat(1024 * 1024 + 10);
    stub.getFile.mockResolvedValueOnce({
      file_path: "big",
      size: big.length,
      encoding: "text",
      content: big,
      blob_id: "b",
      last_commit_sha: null,
      ref: "main",
    });
    const out: any = await getFileContent.handler({ ...where, file_path: "big", ref: "main" }, ctxWith(stub));
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(1024 * 1024);
  });

  it("assign_reviewer: requests new reviewers and cancels unlisted ones", async () => {
    const { stub, calls } = makeStub();
    stub.getPullRequest.mockResolvedValueOnce({
      ...PR,
      requested_reviewers: [
        { id: 2, login: "carol" },
        { id: 3, login: "dave" },
      ],
    });
    await assignReviewer.handler({ ...where, pull_number: 5, reviewers: ["Carol", "erin"] }, ctxWith(stub));
    expect(calls()).toEqual([
      "assertRepoAccess",
      "getPullRequest",
      "requestReviewers",
      "cancelReviewRequests",
      "getPullRequest",
    ]);
    expect(stub.requestReviewers).toHaveBeenCalledWith("o", "r", 5, ["erin"]);
    expect(stub.cancelReviewRequests).toHaveBeenCalledWith("o", "r", 5, ["dave"]);
  });

  it("assign_reviewer: no-op when reviewers already match", async () => {
    const { stub, calls } = makeStub();
    await assignReviewer.handler({ ...where, pull_number: 5, reviewers: ["carol"] }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "getPullRequest", "getPullRequest"]);
  });

  it("set_labels: replaces labels by name", async () => {
    const { stub, calls } = makeStub();
    const out: any = await setLabels.handler({ ...where, pull_number: 5, labels: ["bug"] }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "replaceLabels", "getPullRequest"]);
    expect(out.labels).toEqual(["bug"]);
  });

  it("get_current_user: returns {id,username,name}, no access check", async () => {
    const { stub, calls } = makeStub();
    const out = await getCurrentUserTool.handler({}, ctxWith(stub));
    expect(calls()).toEqual(["getCurrentUser"]);
    expect(out).toEqual({ id: 99, username: "alice", name: "Alice" });
  });

  it("find_user: returns the user (name falls back to login), no access check", async () => {
    const { stub, calls } = makeStub();
    const out = await findUser.handler({ username: "carol" }, ctxWith(stub));
    expect(calls()).toEqual(["findUserByUsername"]);
    expect(out).toEqual({ id: 2, username: "carol", name: "carol" });
  });

  it("find_user: returns null when no user matches", async () => {
    const { stub } = makeStub();
    stub.findUserByUsername.mockResolvedValueOnce(null);
    expect(await findUser.handler({ username: "ghost" }, ctxWith(stub))).toBeNull();
  });

  it("get_pull_request_diff: access first, returns {files}", async () => {
    const { stub, calls } = makeStub();
    const out: any = await getPullRequestDiff.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "getPullRequestDiff"]);
    expect(out.files).toHaveLength(1);
  });

  it("get_pull_request_shas: returns base/head/merge-base SHAs", async () => {
    const { stub } = makeStub();
    const out = await getPullRequestShas.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(out).toEqual({ base_sha: "base1", head_sha: "head1", merge_base_sha: "mb1" });
  });

  it("list_pull_request_discussions: comments, submitted reviews, inline threads grouped by line", async () => {
    const { stub } = makeStub();
    stub.listReviews.mockResolvedValueOnce([
      { id: 1, state: "COMMENT", user: { id: 2, login: "carol" }, body: "", commit_id: "h", stale: false, dismissed: false, comments_count: 2, submitted_at: "t1" },
      { id: 2, state: "REQUEST_REVIEW", user: { id: 3, login: "dave" }, body: "", commit_id: "", stale: false, dismissed: false, comments_count: 0, submitted_at: "t0" },
      { id: 3, state: "COMMENT", user: { id: 99, login: "alice" }, body: "", commit_id: "h", stale: false, dismissed: false, comments_count: 1, submitted_at: "t2" },
    ]);
    const rc = (id: number, review: number, at: string, extra: object) => ({
      id,
      body: `b${id}`,
      user: { id: 1, login: "u" },
      path: "a.ts",
      position: 0,
      original_position: 0,
      commit_id: "h",
      pull_request_review_id: review,
      resolver: null,
      created_at: at,
      ...extra,
    });
    stub.listReviewComments.mockImplementation(async (_o, _r, _i, reviewId) =>
      reviewId === 1
        ? [rc(10, 1, "2026-01-01", { position: 4 }), rc(11, 1, "2026-01-02", { original_position: 4 })]
        : [rc(12, 3, "2026-01-03", { position: 4 })],
    );

    const out: any = await listPullRequestDiscussions.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(stub.listReviewComments).toHaveBeenCalledTimes(2);
    expect(out.comments).toEqual([{ id: 11, author: "carol", body: "hi", created_at: "c" }]);
    expect(out.reviews.map((r: any) => r.id)).toEqual([1, 3]);
    expect(out.threads).toHaveLength(2);
    const newSide = out.threads.find((t: any) => t.side === "new");
    expect(newSide).toMatchObject({ path: "a.ts", line: 4, resolved: false, reply_to: { review_id: 3, comment_id: 12 } });
    expect(newSide.notes.map((n: any) => n.id)).toEqual([10, 12]);
    const oldSide = out.threads.find((t: any) => t.side === "old");
    expect(oldSide.notes.map((n: any) => n.id)).toEqual([11]);
  });

  it("reply_to_review_comment: posts a COMMENT review at the same path/side/line", async () => {
    const { stub, calls } = makeStub();
    stub.listReviewComments.mockResolvedValueOnce([
      { id: 10, path: "src/a.ts", position: 0, original_position: 7, commit_id: "c0", pull_request_review_id: 1 },
    ]);
    const out = await replyToReviewComment.handler(
      { ...where, pull_number: 5, review_id: 1, comment_id: 10, body: "done" },
      ctxWith(stub),
    );
    expect(calls()).toEqual(["assertRepoAccess", "listReviewComments", "createReview"]);
    expect(stub.createReview).toHaveBeenCalledWith("o", "r", 5, {
      event: "COMMENT",
      body: "",
      commit_id: "c0",
      comments: [{ path: "src/a.ts", body: "done", old_position: 7 }],
    });
    expect(out).toEqual({ review_id: 77 });
  });

  it("reply_to_review_comment: 404 when the comment is not in that review", async () => {
    const { stub } = makeStub();
    const err = await replyToReviewComment
      .handler({ ...where, pull_number: 5, review_id: 1, comment_id: 999, body: "x" }, ctxWith(stub))
      .catch((e) => e);
    expect(mapError(err).kind).toBe("not_found");
    expect(stub.createReview).not.toHaveBeenCalled();
  });

  it("approve_pull_request: submits an APPROVED review on someone else's PR", async () => {
    const { stub, calls } = makeStub();
    stub.getPullRequest.mockResolvedValueOnce({ ...PR, user: { id: 7, login: "bob" } });
    const out = await approvePullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(calls()).toEqual(["assertRepoAccess", "getPullRequest", "createReview"]);
    expect(stub.createReview).toHaveBeenCalledWith("o", "r", 5, { event: "APPROVED", body: "" });
    expect(out).toEqual({ approved: true, review_id: 77, approved_by: "alice" });
  });

  it("approve_pull_request: refuses self-approval with a clear forbidden error", async () => {
    const { stub } = makeStub();
    const err = await approvePullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub)).catch((e) => e);
    expect(mapError(err)).toEqual({ kind: "forbidden", message: "You cannot approve your own pull request." });
    expect(stub.createReview).not.toHaveBeenCalled();
  });

  it("unapprove_pull_request: deletes the user's active approvals only", async () => {
    const { stub } = makeStub();
    stub.listReviews.mockResolvedValueOnce([
      { id: 1, state: "APPROVED", user: { id: 99 }, dismissed: false, comments_count: 0 },
      { id: 2, state: "APPROVED", user: { id: 7 }, dismissed: false, comments_count: 0 },
      { id: 3, state: "APPROVED", user: { id: 99 }, dismissed: true, comments_count: 0 },
      { id: 4, state: "COMMENT", user: { id: 99 }, dismissed: false, comments_count: 0 },
    ]);
    const out = await unapprovePullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub));
    expect(stub.deleteReview).toHaveBeenCalledTimes(1);
    expect(stub.deleteReview).toHaveBeenCalledWith("o", "r", 5, 1);
    expect(out).toEqual({ unapproved: true, deleted_review_ids: [1] });
  });

  it("unapprove_pull_request: not_found when there is no approval", async () => {
    const { stub } = makeStub();
    const err = await unapprovePullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub)).catch((e) => e);
    expect(mapError(err).kind).toBe("not_found");
  });

  it("unapprove_pull_request: refuses to delete an approval that carries inline comments", async () => {
    const { stub } = makeStub();
    stub.listReviews.mockResolvedValueOnce([
      { id: 1, state: "APPROVED", user: { id: 99 }, dismissed: false, comments_count: 2 },
    ]);
    const err = await unapprovePullRequest.handler({ ...where, pull_number: 5 }, ctxWith(stub)).catch((e) => e);
    expect(mapError(err).kind).toBe("bad_request");
    expect(stub.deleteReview).not.toHaveBeenCalled();
  });
});

describe("tool input schemas", () => {
  it("reject an owner/repo containing a slash", () => {
    expect(getPullRequest.schema.safeParse({ owner: "o/r", repo: "r", pull_number: 1 }).success).toBe(false);
    expect(getPullRequest.schema.safeParse({ owner: "o", repo: "x/y", pull_number: 1 }).success).toBe(false);
    expect(getPullRequest.schema.safeParse({ owner: "o", repo: "r", pull_number: 1 }).success).toBe(true);
  });

  it("cap per_page at Forgejo's maximum of 50", () => {
    expect(listPullRequests.schema.safeParse({ ...where, per_page: 51 }).success).toBe(false);
  });
});

/**
 * Verify the audit + error-mapping wrapper applied by buildMcpServer by
 * capturing the registered tool callbacks off McpServer.prototype.registerTool.
 */
describe("buildMcpServer audit wrapper", () => {
  async function captureTools(deps: Parameters<typeof buildMcpServer>[1]) {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const captured = new Map<string, (a: unknown) => Promise<any>>();
    const spy = vi
      .spyOn(McpServer.prototype, "registerTool")
      .mockImplementation(function (this: any, name: string, _cfg: unknown, cb: any) {
        captured.set(name, cb);
        return {} as any;
      });
    buildMcpServer(auth, deps);
    spy.mockRestore();
    return captured;
  }

  it("records a success audit entry and returns text content", async () => {
    const audit = { record: vi.fn(async () => undefined) } as any;
    const tokens = { getAccessToken: vi.fn(async () => "tok") } as any;
    const { stub } = makeStub();
    const captured = await captureTools({ audit, tokens, makeForgejo: vi.fn(() => stub as any) });

    const res = await captured.get("get_pull_request")!({ ...where, pull_number: 5 });

    expect(res.content[0].type).toBe("text");
    expect(res.isError).toBeFalsy();
    expect(tokens.getAccessToken).toHaveBeenCalledWith("u1");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      forgejoUsername: "alice",
      toolName: "get_pull_request",
      status: "success",
    });
  });

  it("records an error audit entry and maps the error when a tool throws", async () => {
    const audit = { record: vi.fn(async () => undefined) } as any;
    const tokens = { getAccessToken: vi.fn(async () => "tok") } as any;
    const stub = {
      assertRepoAccess: vi.fn(async () => {
        throw new ForgejoApiError(403, "nope");
      }),
    };
    const captured = await captureTools({ audit, tokens, makeForgejo: vi.fn(() => stub as any) });

    const res = await captured.get("get_pull_request")!({ ...where, pull_number: 5 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/forbidden/);
    expect(audit.record.mock.calls[0][0]).toMatchObject({ status: "error", toolName: "get_pull_request" });
    expect(audit.record.mock.calls[0][0].errorMessage).toMatch(/forbidden/);
  });

  it("a failing audit write does not change the tool result", async () => {
    const audit = { record: vi.fn(async () => { throw new Error("db down"); }) } as any;
    const tokens = { getAccessToken: vi.fn(async () => "tok") } as any;
    const { stub } = makeStub();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const captured = await captureTools({ audit, tokens, makeForgejo: vi.fn(() => stub as any) });

    const res = await captured.get("get_current_user")!({});
    expect(res.isError).toBeFalsy();
    errSpy.mockRestore();
  });
});

describe("tool registry", () => {
  it("registers all 21 tools with unique names", () => {
    expect(TOOLS).toHaveLength(21);
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(21);
    expect([...names].sort()).toEqual(
      [
        "add_comment",
        "approve_pull_request",
        "assign_reviewer",
        "create_pull_request",
        "find_user",
        "get_current_user",
        "get_file_content",
        "get_job_log",
        "get_pull_request",
        "get_pull_request_diff",
        "get_pull_request_shas",
        "get_workflow_run",
        "get_workflow_run_jobs",
        "list_pull_request_discussions",
        "list_pull_requests",
        "list_workflow_runs",
        "reply_to_review_comment",
        "retry_job",
        "set_labels",
        "unapprove_pull_request",
        "update_pull_request",
      ].sort(),
    );
  });
});

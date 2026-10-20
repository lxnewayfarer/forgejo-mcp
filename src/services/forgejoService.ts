import { getConfig } from "../config/index.js";
import { ForgejoApiError } from "../middleware/errors.js";

/**
 * ForgejoService is the ONLY component permitted to call the Forgejo REST API.
 * Every method acts on behalf of a single user via that user's access token,
 * so Forgejo enforces the real permission model. No shared/service token exists.
 *
 * Repositories are addressed by (owner, repo); pull requests by their
 * repo-scoped `index` (the number shown in the UI, e.g. #42).
 */

export interface UserRef {
  id: number;
  login: string;
  full_name?: string;
}

export interface Label {
  id: number;
  name: string;
}

export interface BranchInfo {
  label: string;
  ref: string;
  sha: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  html_url: string;
  head: BranchInfo;
  base: BranchInfo;
  merge_base?: string;
  labels?: Label[] | null;
  user?: UserRef | null;
  assignees?: UserRef[] | null;
  requested_reviewers?: UserRef[] | null;
  mergeable?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  body: string;
  user: UserRef | null;
  html_url?: string;
  created_at: string;
  updated_at?: string;
}

export interface User {
  id: number;
  login: string;
  full_name?: string;
}

export interface DiffFile {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

export type ReviewState =
  | "APPROVED"
  | "PENDING"
  | "COMMENT"
  | "REQUEST_CHANGES"
  | "REQUEST_REVIEW"
  | string;

export interface Review {
  id: number;
  body: string;
  user: UserRef | null;
  state: ReviewState;
  commit_id: string;
  stale: boolean;
  official: boolean;
  dismissed: boolean;
  comments_count: number;
  submitted_at: string;
  html_url?: string;
}

export interface ReviewComment {
  id: number;
  body: string;
  user: UserRef | null;
  path: string;
  /** New-side line number (0 when the comment is on the old side). */
  position: number;
  /** Old-side line number (0 when the comment is on the new side). */
  original_position: number;
  commit_id: string;
  original_commit_id?: string;
  diff_hunk?: string;
  pull_request_review_id: number;
  resolver?: UserRef | null;
  html_url?: string;
  created_at: string;
}

export interface WorkflowRun {
  id: number;
  index_in_repo: number;
  title: string;
  status: string;
  event: string;
  workflow_id: string;
  prettyref?: string;
  commit_sha: string;
  html_url: string;
  /** Nanoseconds. */
  duration?: number;
  created: string;
  updated: string;
  started?: string;
  stopped?: string;
}

export interface WorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  attempt: number;
  /** Present from Forgejo 17. */
  html_url?: string;
  needs?: string[] | null;
  runs_on?: string[] | null;
  task_id: number;
}

export interface RepositoryFile {
  file_path: string;
  size: number;
  /**
   * How `content` is encoded: "text" for a decoded UTF-8 string, or "base64"
   * for a binary file we could not safely decode as text (content is then the
   * raw base64 the caller can decode themselves).
   */
  encoding: "text" | "base64";
  content: string;
  blob_id: string;
  last_commit_sha: string | null;
  ref: string;
}

export interface ListResult<T> {
  items: T[];
  pagination: {
    page: number;
    perPage: number;
    total: number | null;
    totalPages: number | null;
    nextPage: number | null;
  };
}

export interface ListPullRequestsParams {
  state?: "open" | "closed" | "all";
  poster?: string;
  base?: string;
  head?: string;
  page?: number;
  perPage?: number;
}

export interface ListWorkflowRunsParams {
  ref?: string;
  status?: string;
  event?: string;
  page?: number;
  perPage?: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Upper bound on pages walked by auto-paginating helpers (guards loops). */
const MAX_AUTO_PAGES = 50;

export class ForgejoService {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = getConfig().forgejoApiBase;
  }

  // --- low-level request helper ------------------------------------------

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  /**
   * Performs the fetch and, on a non-2xx response, throws a ForgejoApiError
   * carrying Forgejo's structured {message} string (falling back to the status
   * text). The whole body is never echoed — only the structured field — so
   * arbitrary server content can't leak downstream.
   */
  private async fetchOrThrow(
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    const res = await this.fetchImpl(url, { method, headers: init.headers, body: init.body });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      let message = res.statusText;
      try {
        const errJson = (await res.json()) as { message?: unknown; error?: unknown };
        message =
          (typeof errJson.message === "string" && errJson.message) ||
          (typeof errJson.error === "string" && errJson.error) ||
          res.statusText;
      } catch {
        /* keep statusText */
      }
      throw new ForgejoApiError(res.status, message, retryAfter);
    }
    return res;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await this.fetchOrThrow(method, this.buildUrl(path, opts.query), { headers, body });
    // Some Forgejo endpoints answer 204, others 200/201 with an empty body.
    const text = res.status === 204 ? "" : await res.text();
    const data = (text ? JSON.parse(text) : null) as T;
    return { data, headers: res.headers };
  }

  /**
   * Like request() but asserts a non-empty body. Methods that promise a concrete
   * object use this so a stray 204/empty response surfaces as a clear error
   * instead of a null masquerading as the typed value.
   */
  private async requestData<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const res = await this.request<T>(method, path, opts);
    if (res.data === null || res.data === undefined) {
      throw new ForgejoApiError(502, "Forgejo returned an empty response where data was expected.");
    }
    return res as { data: T; headers: Headers };
  }

  /**
   * Like request() but for endpoints that return plain text rather than JSON
   * (a .diff or a job log). Shares the same URL build + error path.
   */
  private async requestText(path: string, opts: { query?: Query } = {}): Promise<string> {
    const res = await this.fetchOrThrow("GET", this.buildUrl(path, opts.query), {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "text/plain" },
    });
    return res.text();
  }

  private repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /**
   * Forgejo reports the total via X-Total-Count (no page-count headers), so the
   * remaining pagination fields are derived from it. When the header is absent
   * a full page is taken as a hint that another page may exist.
   */
  private paginationFrom(
    total: number | null,
    returned: number,
    page: number,
    perPage: number,
  ): ListResult<unknown>["pagination"] {
    const totalPages = total != null ? Math.ceil(total / perPage) : null;
    const hasNext = totalPages != null ? page < totalPages : returned >= perPage;
    return { page, perPage, total, totalPages, nextPage: hasNext ? page + 1 : null };
  }

  private totalFrom(headers: Headers): number | null {
    const v = headers.get("x-total-count");
    const n = v != null && v !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  // --- authorization helper ----------------------------------------------

  /**
   * Confirms the user can access the repository. Throws ForgejoApiError(403/404)
   * otherwise. Forgejo itself is the authority on access.
   */
  async assertRepoAccess(owner: string, repo: string): Promise<void> {
    await this.request("GET", this.repoPath(owner, repo));
  }

  // --- pull requests -------------------------------------------------------

  async createPullRequest(
    owner: string,
    repo: string,
    input: {
      head: string;
      base: string;
      title: string;
      body?: string;
      assignees?: string[];
    },
  ): Promise<PullRequest> {
    const { data } = await this.requestData<PullRequest>(
      "POST",
      `${this.repoPath(owner, repo)}/pulls`,
      {
        body: {
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
          assignees: input.assignees,
        },
      },
    );
    return data;
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    index: number,
    input: { title?: string; body?: string; assignees?: string[] },
  ): Promise<PullRequest> {
    const { data } = await this.requestData<PullRequest>(
      "PATCH",
      `${this.repoPath(owner, repo)}/pulls/${index}`,
      { body: { title: input.title, body: input.body, assignees: input.assignees } },
    );
    return data;
  }

  async getPullRequest(owner: string, repo: string, index: number): Promise<PullRequest> {
    const { data } = await this.requestData<PullRequest>(
      "GET",
      `${this.repoPath(owner, repo)}/pulls/${index}`,
    );
    return data;
  }

  async listPullRequests(
    owner: string,
    repo: string,
    params: ListPullRequestsParams,
  ): Promise<ListResult<PullRequest>> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? 20;
    const { data, headers } = await this.request<Array<PullRequest | null>>(
      "GET",
      `${this.repoPath(owner, repo)}/pulls`,
      {
        query: {
          state: params.state,
          poster: params.poster,
          base: params.base,
          head: params.head,
          page,
          limit: perPage,
        },
      },
    );
    // Forgejo documents that a PR it fails to load comes back as null.
    const raw = data ?? [];
    const items = raw.filter((p): p is PullRequest => p !== null);
    return {
      items,
      pagination: this.paginationFrom(this.totalFrom(headers), raw.length, page, perPage),
    };
  }

  /** Replace the PR's labels by name (PRs share the issue label endpoint). */
  async replaceLabels(owner: string, repo: string, index: number, labels: string[]): Promise<Label[]> {
    const { data } = await this.request<Label[]>(
      "PUT",
      `${this.repoPath(owner, repo)}/issues/${index}/labels`,
      { body: { labels } },
    );
    return data ?? [];
  }

  async requestReviewers(owner: string, repo: string, index: number, reviewers: string[]): Promise<void> {
    await this.request("POST", `${this.repoPath(owner, repo)}/pulls/${index}/requested_reviewers`, {
      body: { reviewers },
    });
  }

  async cancelReviewRequests(owner: string, repo: string, index: number, reviewers: string[]): Promise<void> {
    await this.request("DELETE", `${this.repoPath(owner, repo)}/pulls/${index}/requested_reviewers`, {
      body: { reviewers },
    });
  }

  /**
   * Full unified diff of a PR, split per file. Forgejo serves the diff as raw
   * text (GET /pulls/{index}.diff); we parse it into GitLab-style file entries
   * so agents get old/new path + flags + the hunk text.
   */
  async getPullRequestDiff(owner: string, repo: string, index: number): Promise<DiffFile[]> {
    const raw = await this.requestText(`${this.repoPath(owner, repo)}/pulls/${index}.diff`);
    return parseUnifiedDiff(raw);
  }

  // --- comments -------------------------------------------------------------

  async addComment(owner: string, repo: string, index: number, body: string): Promise<Comment> {
    const { data } = await this.requestData<Comment>(
      "POST",
      `${this.repoPath(owner, repo)}/issues/${index}/comments`,
      { body: { body } },
    );
    return data;
  }

  /** All plain (non-review) comments on the PR conversation. */
  async listComments(owner: string, repo: string, index: number): Promise<Comment[]> {
    const { data } = await this.request<Comment[]>(
      "GET",
      `${this.repoPath(owner, repo)}/issues/${index}/comments`,
    );
    return data ?? [];
  }

  // --- reviews -------------------------------------------------------------

  /** Every review on the PR (auto-paginated). */
  async listReviews(owner: string, repo: string, index: number): Promise<Review[]> {
    const out: Review[] = [];
    const perPage = 50;
    for (let page = 1; page <= MAX_AUTO_PAGES; page++) {
      const { data, headers } = await this.request<Review[]>(
        "GET",
        `${this.repoPath(owner, repo)}/pulls/${index}/reviews`,
        { query: { page, limit: perPage } },
      );
      const batch = data ?? [];
      out.push(...batch);
      const { nextPage } = this.paginationFrom(this.totalFrom(headers), batch.length, page, perPage);
      if (nextPage === null || batch.length === 0) break;
    }
    return out;
  }

  async listReviewComments(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
  ): Promise<ReviewComment[]> {
    const { data } = await this.request<ReviewComment[]>(
      "GET",
      `${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}/comments`,
    );
    return data ?? [];
  }

  /**
   * Submit a review. `event` APPROVED/REQUEST_CHANGES/COMMENT submits it at
   * once; inline `comments` are anchored by path + new/old line number.
   */
  async createReview(
    owner: string,
    repo: string,
    index: number,
    input: {
      event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT";
      body?: string;
      commit_id?: string;
      comments?: Array<{ path: string; body: string; new_position?: number; old_position?: number }>;
    },
  ): Promise<Review> {
    const { data } = await this.requestData<Review>(
      "POST",
      `${this.repoPath(owner, repo)}/pulls/${index}/reviews`,
      { body: input },
    );
    return data;
  }

  async deleteReview(owner: string, repo: string, index: number, reviewId: number): Promise<void> {
    await this.request("DELETE", `${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}`);
  }

  // --- users ---------------------------------------------------------------

  async getCurrentUser(): Promise<User> {
    const { data } = await this.requestData<User>("GET", "/user");
    return data;
  }

  async findUserByUsername(username: string): Promise<User | null> {
    // A missing user is a normal "no match" result, not an error.
    try {
      const { data } = await this.request<User>("GET", `/users/${encodeURIComponent(username)}`);
      return data ?? null;
    } catch (err) {
      if (err instanceof ForgejoApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** The Forgejo server version string, e.g. "13.0.5+gitea-1.22.0". */
  async getVersion(): Promise<string> {
    const { data } = await this.requestData<{ version: string }>("GET", "/version");
    return data.version;
  }

  // --- actions (CI) ----------------------------------------------------------

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRun> {
    const { data } = await this.requestData<WorkflowRun>(
      "GET",
      `${this.repoPath(owner, repo)}/actions/runs/${runId}`,
    );
    return data;
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    params: ListWorkflowRunsParams,
  ): Promise<ListResult<WorkflowRun>> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? 20;
    const { data } = await this.request<{ total_count?: number; workflow_runs?: WorkflowRun[] | null }>(
      "GET",
      `${this.repoPath(owner, repo)}/actions/runs`,
      {
        query: {
          ref: params.ref,
          status: params.status,
          event: params.event,
          page,
          limit: perPage,
        },
      },
    );
    const items = data?.workflow_runs ?? [];
    const total = typeof data?.total_count === "number" ? data.total_count : null;
    return { items, pagination: this.paginationFrom(total, items.length, page, perPage) };
  }

  async listWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<WorkflowJob[]> {
    const { data } = await this.request<WorkflowJob[]>(
      "GET",
      `${this.repoPath(owner, repo)}/actions/runs/${runId}/jobs`,
    );
    return data ?? [];
  }

  /** A single Actions job (Forgejo 17+). */
  async getWorkflowJob(owner: string, repo: string, jobId: number): Promise<WorkflowJob> {
    const { data } = await this.requestData<WorkflowJob>(
      "GET",
      `${this.repoPath(owner, repo)}/actions/jobs/${jobId}`,
    );
    return data;
  }

  /**
   * Rerun a completed Actions job and the jobs that depend on it (Forgejo 17+).
   * The job keeps its id; the rerun is a new attempt of it.
   */
  async rerunJob(owner: string, repo: string, jobId: number): Promise<void> {
    await this.request("POST", `${this.repoPath(owner, repo)}/actions/jobs/${jobId}/rerun`);
  }

  /** Plain-text log of an Actions job (latest attempt unless `attempt` given). */
  async getJobLog(owner: string, repo: string, jobId: number, attempt?: number): Promise<string> {
    return this.requestText(`${this.repoPath(owner, repo)}/actions/jobs/${jobId}/logs`, {
      query: { attempt },
    });
  }

  // --- repository files ---------------------------------------------------

  /**
   * A single repository file at a given ref. Forgejo returns the content
   * base64-encoded; we decode it to a UTF-8 string when it is real text. Path
   * segments are encoded individually (slashes stay as separators).
   */
  async getFile(owner: string, repo: string, path: string, ref: string): Promise<RepositoryFile> {
    const encodedPath = path
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const { data } = await this.requestData<
      | {
          type: string;
          path: string;
          size: number;
          encoding?: string | null;
          content?: string | null;
          sha: string;
          last_commit_sha?: string;
        }
      | unknown[]
    >("GET", `${this.repoPath(owner, repo)}/contents/${encodedPath}`, { query: { ref } });

    if (Array.isArray(data) || data.type !== "file") {
      throw new ForgejoApiError(
        400,
        `'${path}' is not a regular file at ref '${ref}' (it is a ${Array.isArray(data) ? "directory" : data.type}).`,
      );
    }
    if (data.content == null) {
      throw new ForgejoApiError(413, `'${path}' is too large for Forgejo to return its content.`);
    }
    // Return a UTF-8 string only if it round-trips losslessly (i.e. it's real
    // text). Binary blobs stay base64 so we never hand back U+FFFD-mangled text.
    const raw =
      data.encoding === "base64" ? Buffer.from(data.content, "base64") : Buffer.from(data.content, "utf-8");
    const text = raw.toString("utf-8");
    const isText = Buffer.from(text, "utf-8").equals(raw);
    return {
      file_path: data.path,
      size: data.size,
      encoding: isText ? "text" : "base64",
      content: isText ? text : raw.toString("base64"),
      blob_id: data.sha,
      last_commit_sha: data.last_commit_sha ?? null,
      ref,
    };
  }
}

/**
 * Split a `git diff` style unified diff into per-file entries. Paths come from
 * the ---/+++ lines (or rename/copy headers, or the `diff --git` line for
 * mode-only and binary changes); `diff` holds everything from the first hunk
 * (or the "Binary files … differ" note) onward.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));

  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0]);
    let oldPath = header?.[1] ?? "";
    let newPath = header?.[2] ?? "";
    let newFile = false;
    let deletedFile = false;
    let renamed = false;
    let bodyStart = lines.length;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("@@") || line.startsWith("Binary files ")) {
        bodyStart = i;
        break;
      }
      if (line.startsWith("new file mode")) newFile = true;
      else if (line.startsWith("deleted file mode")) deletedFile = true;
      else if (line.startsWith("rename from ")) {
        renamed = true;
        oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        renamed = true;
        newPath = line.slice("rename to ".length);
      } else if (line.startsWith("--- ")) {
        const p = unquote(line.slice(4));
        if (p !== "/dev/null") oldPath = p.replace(/^a\//, "");
      } else if (line.startsWith("+++ ")) {
        const p = unquote(line.slice(4));
        if (p !== "/dev/null") newPath = p.replace(/^b\//, "");
      }
    }

    if (newFile) oldPath = newPath;
    if (deletedFile) newPath = oldPath;

    let diff = lines.slice(bodyStart).join("\n");
    if (!diff.endsWith("\n") && diff.length > 0) diff += "\n";

    files.push({
      old_path: oldPath,
      new_path: newPath,
      diff,
      new_file: newFile,
      renamed_file: renamed,
      deleted_file: deletedFile,
    });
  }
  return files;
}

/** git quotes paths with unusual characters ("a/sp ace\t.txt"); strip that. */
function unquote(p: string): string {
  const trimmed = p.replace(/\t.*$/, "");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

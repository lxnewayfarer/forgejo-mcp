import { describe, it, expect, beforeAll, vi } from "vitest";
import { installTestConfig } from "../helpers/config.js";
import { ForgejoService, parseUnifiedDiff } from "../../src/services/forgejoService.js";
import { ForgejoApiError } from "../../src/middleware/errors.js";

const API = "https://forgejo.example.com/api/v1";

beforeAll(() => {
  installTestConfig();
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
  });
}

function call(fetchImpl: ReturnType<typeof vi.fn>, n = 0) {
  const [url, init] = fetchImpl.mock.calls[n] as [string, RequestInit];
  return {
    url: String(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

describe("ForgejoService", () => {
  it("sends the OAuth token as a Bearer header and encodes owner/repo", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await svc.assertRepoAccess("my org", "re/po");
    const c = call(fetchImpl);
    expect(c.url).toBe(`${API}/repos/my%20org/re%2Fpo`);
    expect(c.headers.Authorization).toBe("Bearer tok");
  });

  it("createPullRequest posts head/base/title/body/assignees", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 10, number: 2, html_url: "u", state: "open" }, { status: 201 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const pr = await svc.createPullRequest("o", "r", {
      head: "feat",
      base: "main",
      title: "T",
      body: "D",
      assignees: ["bob"],
    });
    const c = call(fetchImpl);
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${API}/repos/o/r/pulls`);
    expect(c.body).toEqual({ head: "feat", base: "main", title: "T", body: "D", assignees: ["bob"] });
    expect(pr.number).toBe(2);
  });

  it("updatePullRequest PATCHes the pull path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 10, number: 9 }, { status: 201 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await svc.updatePullRequest("o", "r", 9, { title: "T2" });
    const c = call(fetchImpl);
    expect(c.method).toBe("PATCH");
    expect(c.url).toBe(`${API}/repos/o/r/pulls/9`);
    expect(c.body).toEqual({ title: "T2" });
  });

  it("listPullRequests maps filters, drops null entries and derives pagination from X-Total-Count", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: 1, number: 1 }, null], { headers: { "x-total-count": "45" } }),
    );
    const svc = new ForgejoService("tok", fetchImpl as any);
    const res = await svc.listPullRequests("o", "r", { state: "open", poster: "alice", page: 2, perPage: 20 });
    expect(call(fetchImpl).url).toBe(`${API}/repos/o/r/pulls?state=open&poster=alice&page=2&limit=20`);
    expect(res.items).toHaveLength(1);
    expect(res.pagination).toEqual({ page: 2, perPage: 20, total: 45, totalPages: 3, nextPage: 3 });
  });

  it("listPullRequests without X-Total-Count guesses nextPage from a full page", async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ id: i, number: i }));
    const svc = new ForgejoService("tok", vi.fn(async () => jsonResponse(full)) as any);
    const res = await svc.listPullRequests("o", "r", { perPage: 2 });
    expect(res.pagination).toEqual({ page: 1, perPage: 2, total: null, totalPages: null, nextPage: 2 });

    const svc2 = new ForgejoService("tok", vi.fn(async () => jsonResponse([full[0]])) as any);
    const res2 = await svc2.listPullRequests("o", "r", { perPage: 2 });
    expect(res2.pagination.nextPage).toBeNull();
  });

  it("replaceLabels PUTs label names to the issue labels endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 1, name: "bug" }]));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const out = await svc.replaceLabels("o", "r", 3, ["bug", "a,b"]);
    const c = call(fetchImpl);
    expect(c.method).toBe("PUT");
    expect(c.url).toBe(`${API}/repos/o/r/issues/3/labels`);
    expect(c.body).toEqual({ labels: ["bug", "a,b"] });
    expect(out).toEqual([{ id: 1, name: "bug" }]);
  });

  it("requestReviewers / cancelReviewRequests hit requested_reviewers with POST / DELETE", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await svc.requestReviewers("o", "r", 3, ["carol"]);
    await svc.cancelReviewRequests("o", "r", 3, ["dave"]);
    expect(call(fetchImpl, 0)).toMatchObject({
      method: "POST",
      url: `${API}/repos/o/r/pulls/3/requested_reviewers`,
      body: { reviewers: ["carol"] },
    });
    expect(call(fetchImpl, 1)).toMatchObject({ method: "DELETE", body: { reviewers: ["dave"] } });
  });

  it("throws ForgejoApiError with Forgejo's message on 403", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "forbidden", url: "x" }, { status: 403 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const err = await svc.getPullRequest("o", "r", 1).catch((e) => e);
    expect(err).toBeInstanceOf(ForgejoApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("forbidden");
  });

  it("captures retry-after on 429", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "slow down" }, { status: 429, headers: { "retry-after": "30" } }),
    );
    const svc = new ForgejoService("tok", fetchImpl as any);
    const err = await svc.getCurrentUser().catch((e) => e);
    expect(err.retryAfter).toBe(30);
  });

  it("requestData rejects an empty 2xx body", async () => {
    const svc = new ForgejoService("tok", vi.fn(async () => new Response("", { status: 200 })) as any);
    const err = await svc.getPullRequest("o", "r", 1).catch((e) => e);
    expect(err).toBeInstanceOf(ForgejoApiError);
    expect(err.status).toBe(502);
  });

  it("addComment posts to the issue comments endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 5, body: "hi" }, { status: 201 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await svc.addComment("o", "r", 3, "hi");
    expect(call(fetchImpl)).toMatchObject({
      method: "POST",
      url: `${API}/repos/o/r/issues/3/comments`,
      body: { body: "hi" },
    });
  });

  it("getPullRequestDiff fetches the .diff as text and parses it", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const fetchImpl = vi.fn(async () => textResponse(diff));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const files = await svc.getPullRequestDiff("o", "r", 4);
    expect(call(fetchImpl).url).toBe(`${API}/repos/o/r/pulls/4.diff`);
    expect(files).toEqual([
      {
        old_path: "src/a.ts",
        new_path: "src/a.ts",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
        new_file: false,
        renamed_file: false,
        deleted_file: false,
      },
    ]);
  });

  it("listReviews walks pages until X-Total-Count is reached", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    const page2 = [{ id: 51 }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1, { headers: { "x-total-count": "51" } }))
      .mockResolvedValueOnce(jsonResponse(page2, { headers: { "x-total-count": "51" } }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const reviews = await svc.listReviews("o", "r", 2);
    expect(reviews).toHaveLength(51);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(call(fetchImpl, 1).url).toBe(`${API}/repos/o/r/pulls/2/reviews?page=2&limit=50`);
  });

  it("createReview posts event/body/comments", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 9, state: "APPROVED" }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await svc.createReview("o", "r", 2, {
      event: "COMMENT",
      body: "",
      commit_id: "abc",
      comments: [{ path: "a.ts", body: "x", new_position: 3 }],
    });
    expect(call(fetchImpl)).toMatchObject({
      method: "POST",
      url: `${API}/repos/o/r/pulls/2/reviews`,
      body: { event: "COMMENT", body: "", commit_id: "abc", comments: [{ path: "a.ts", body: "x", new_position: 3 }] },
    });
  });

  it("deleteReview DELETEs the review and tolerates 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await expect(svc.deleteReview("o", "r", 2, 9)).resolves.toBeUndefined();
    expect(call(fetchImpl)).toMatchObject({ method: "DELETE", url: `${API}/repos/o/r/pulls/2/reviews/9` });
  });

  it("getCurrentUser GETs /user", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, login: "alice", full_name: "Alice" }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const u = await svc.getCurrentUser();
    expect(call(fetchImpl).url).toBe(`${API}/user`);
    expect(u.login).toBe("alice");
  });

  it("findUserByUsername returns the user, or null on 404", async () => {
    const ok = new ForgejoService("tok", vi.fn(async () => jsonResponse({ id: 2, login: "bob" })) as any);
    expect(await ok.findUserByUsername("bob")).toEqual({ id: 2, login: "bob" });

    const missing = new ForgejoService(
      "tok",
      vi.fn(async () => jsonResponse({ message: "user does not exist" }, { status: 404 })) as any,
    );
    expect(await missing.findUserByUsername("ghost")).toBeNull();

    const broken = new ForgejoService("tok", vi.fn(async () => jsonResponse({}, { status: 500 })) as any);
    await expect(broken.findUserByUsername("x")).rejects.toBeInstanceOf(ForgejoApiError);
  });

  it("listWorkflowRuns forwards filters and reads total_count from the body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] }),
    );
    const svc = new ForgejoService("tok", fetchImpl as any);
    const res = await svc.listWorkflowRuns("o", "r", {
      ref: "refs/heads/main",
      status: "failure",
      page: 1,
      perPage: 2,
    });
    expect(call(fetchImpl).url).toBe(
      `${API}/repos/o/r/actions/runs?ref=refs%2Fheads%2Fmain&status=failure&page=1&limit=2`,
    );
    expect(res.items).toHaveLength(2);
    expect(res.pagination).toEqual({ page: 1, perPage: 2, total: 3, totalPages: 2, nextPage: 2 });
  });

  it("listWorkflowRunJobs GETs the run jobs path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 7, name: "build" }]));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const jobs = await svc.listWorkflowRunJobs("o", "r", 55);
    expect(call(fetchImpl).url).toBe(`${API}/repos/o/r/actions/runs/55/jobs`);
    expect(jobs).toHaveLength(1);
  });

  it("getJobLog GETs the job logs path as plain text, with optional attempt", async () => {
    const fetchImpl = vi.fn(async () => textResponse("line1\nline2"));
    const svc = new ForgejoService("tok", fetchImpl as any);
    const log = await svc.getJobLog("o", "r", 123, 2);
    expect(call(fetchImpl).url).toBe(`${API}/repos/o/r/actions/jobs/123/logs?attempt=2`);
    expect(call(fetchImpl).headers.Accept).toBe("text/plain");
    expect(log).toBe("line1\nline2");
  });

  it("rerunJob POSTs the job rerun path and tolerates 204; getWorkflowJob GETs the job", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ id: 7, attempt: 2, status: "waiting" }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    await expect(svc.rerunJob("o", "r", 7)).resolves.toBeUndefined();
    const job = await svc.getWorkflowJob("o", "r", 7);
    expect(call(fetchImpl, 0)).toMatchObject({ method: "POST", url: `${API}/repos/o/r/actions/jobs/7/rerun` });
    expect(call(fetchImpl, 1)).toMatchObject({ method: "GET", url: `${API}/repos/o/r/actions/jobs/7` });
    expect(job.attempt).toBe(2);
  });

  it("getVersion GETs /version", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "17.0.0+gitea-1.22.0" }));
    const svc = new ForgejoService("tok", fetchImpl as any);
    expect(await svc.getVersion()).toBe("17.0.0+gitea-1.22.0");
    expect(call(fetchImpl).url).toBe(`${API}/version`);
  });

  it("getJobLog throws ForgejoApiError on 404", async () => {
    const svc = new ForgejoService("tok", vi.fn(async () => jsonResponse({ message: "nf" }, { status: 404 })) as any);
    await expect(svc.getJobLog("o", "r", 1)).rejects.toBeInstanceOf(ForgejoApiError);
  });

  it("getFile encodes path segments, forwards ref, and decodes text as utf-8", async () => {
    const content = Buffer.from("héllo", "utf-8").toString("base64");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "src/a b.ts",
        size: 6,
        encoding: "base64",
        content,
        sha: "blob1",
        last_commit_sha: "c1",
      }),
    );
    const svc = new ForgejoService("tok", fetchImpl as any);
    const f = await svc.getFile("o", "r", "src/a b.ts", "main");
    expect(call(fetchImpl).url).toBe(`${API}/repos/o/r/contents/src/a%20b.ts?ref=main`);
    expect(f).toEqual({
      file_path: "src/a b.ts",
      size: 6,
      encoding: "text",
      content: "héllo",
      blob_id: "blob1",
      last_commit_sha: "c1",
      ref: "main",
    });
  });

  it("getFile keeps binary content as base64 instead of mangling it", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ type: "file", path: "x.bin", size: 4, encoding: "base64", content: bytes.toString("base64"), sha: "b" }),
    );
    const svc = new ForgejoService("tok", fetchImpl as any);
    const f = await svc.getFile("o", "r", "x.bin", "main");
    expect(f.encoding).toBe("base64");
    expect(Buffer.from(f.content, "base64").equals(bytes)).toBe(true);
  });

  it("getFile rejects directories and oversized files", async () => {
    const dir = new ForgejoService("tok", vi.fn(async () => jsonResponse([{ name: "a" }])) as any);
    await expect(dir.getFile("o", "r", "src", "main")).rejects.toMatchObject({ status: 400 });

    const big = new ForgejoService(
      "tok",
      vi.fn(async () => jsonResponse({ type: "file", path: "big", size: 99, content: null, sha: "b" })) as any,
    );
    await expect(big.getFile("o", "r", "big", "main")).rejects.toMatchObject({ status: 413 });
  });
});

describe("parseUnifiedDiff", () => {
  it("handles new, deleted, renamed and binary files", () => {
    const raw = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/old name.md b/new name.md",
      "similarity index 90%",
      "rename from old name.md",
      "rename to new name.md",
      "--- a/old name.md\t",
      "+++ b/new name.md\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/img.png b/img.png",
      "index 1..2 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(raw);
    expect(files.map((f) => [f.old_path, f.new_path, f.new_file, f.deleted_file, f.renamed_file])).toEqual([
      ["new.txt", "new.txt", true, false, false],
      ["gone.txt", "gone.txt", false, true, false],
      ["old name.md", "new name.md", false, false, true],
      ["img.png", "img.png", false, false, false],
    ]);
    expect(files[0].diff).toBe("@@ -0,0 +1 @@\n+hello\n");
    expect(files[3].diff).toBe("Binary files a/img.png and b/img.png differ\n");
  });

  it("handles a pure rename with no content change", () => {
    const raw = "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n";
    expect(parseUnifiedDiff(raw)).toEqual([
      { old_path: "a.txt", new_path: "b.txt", diff: "", new_file: false, renamed_file: true, deleted_file: false },
    ]);
  });

  it("unquotes git-quoted paths", () => {
    const raw = 'diff --git "a/q\\"x" "b/q\\"x"\n--- "a/q\\"x"\n+++ "b/q\\"x"\n@@ -1 +1 @@\n-a\n+b\n';
    const [f] = parseUnifiedDiff(raw);
    expect(f.old_path).toBe('q"x');
    expect(f.new_path).toBe('q"x');
  });

  it("returns [] for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

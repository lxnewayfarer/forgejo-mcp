import { z } from "zod";
import { defineTool, type ToolContext } from "../types.js";
import { AppError, ForgejoApiError } from "../../middleware/errors.js";
import { owner, repo, sliceByBytes, page, perPage } from "./common.js";

const JOB_LOG_DEFAULT_BYTES = 64 * 1024; // 64 KiB
const JOB_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB

// Runners emit SGR color codes plus cursor/clear-line sequences (the general
// CSI form). Strip them and stray carriage returns so the log is clean text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function cleanLog(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}

/** Forgejo reports run duration in nanoseconds; agents get whole seconds. */
function seconds(ns: number | undefined): number | null {
  return typeof ns === "number" && ns > 0 ? Math.round(ns / 1e9) : null;
}

/** Forgejo uses the zero time for "not yet" timestamps. */
function timestamp(t: string | undefined): string | null {
  return t && !t.startsWith("0001-01-01") ? t : null;
}

/**
 * Forgejo releases that first expose each Actions endpoint used here.
 * Runs exist in every supported release; verified against 13.0, 14.0, 15.0,
 * 16.0 and 17.0 API specs.
 */
const MIN_VERSION = { jobs: 16, logs: 16, rerun: 17 } as const;

/**
 * Called when an Actions endpoint answered 404. On an instance older than the
 * release that introduced the endpoint, that 404 means "no such API", not "no
 * such job" — say so. Otherwise rethrow the original error.
 */
async function explainMissingApi(
  ctx: ToolContext,
  err: unknown,
  feature: keyof typeof MIN_VERSION,
  what: string,
): Promise<never> {
  if (err instanceof ForgejoApiError && err.status === 404) {
    const version = await ctx.forgejo.getVersion().catch(() => null);
    const major = version ? Number(/^(\d+)\./.exec(version)?.[1]) : NaN;
    if (Number.isFinite(major) && major < MIN_VERSION[feature]) {
      throw new AppError(
        "not_found",
        `This Forgejo instance (version ${version}) does not provide ${what} through its API; Forgejo ${MIN_VERSION[feature]} or newer is required. Use the web UI instead.`,
      );
    }
  }
  throw err;
}

const runId = z.number().int().positive().describe("Workflow run id (from list_workflow_runs)");

export const getWorkflowRun = defineTool({
  name: "get_workflow_run",
  description: "Get the status, URL and timestamps of a Forgejo Actions workflow run.",
  schema: z.object({
    owner,
    repo,
    run_id: runId,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const r = await ctx.forgejo.getWorkflowRun(input.owner, input.repo, input.run_id);
    return {
      id: r.id,
      run_number: r.index_in_repo,
      title: r.title,
      workflow: r.workflow_id,
      status: r.status,
      event: r.event,
      ref: r.prettyref ?? null,
      sha: r.commit_sha,
      url: r.html_url,
      duration_seconds: seconds(r.duration),
      created_at: r.created,
      updated_at: r.updated,
      started_at: timestamp(r.started),
      finished_at: timestamp(r.stopped),
    };
  },
});

export const listWorkflowRuns = defineTool({
  name: "list_workflow_runs",
  description:
    "List Forgejo Actions workflow runs in a repository, optionally filtered by branch, status and trigger event.",
  schema: z.object({
    owner,
    repo,
    branch: z
      .string()
      .optional()
      .describe("Branch name or full git ref (e.g. 'main' or 'refs/tags/v1.0')"),
    status: z
      .enum(["unknown", "waiting", "running", "success", "failure", "cancelled", "skipped", "blocked"])
      .optional(),
    event: z.string().optional().describe("Trigger event, e.g. 'push', 'pull_request', 'workflow_dispatch'"),
    page,
    per_page: perPage,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const ref =
      input.branch && !input.branch.startsWith("refs/") ? `refs/heads/${input.branch}` : input.branch;
    const result = await ctx.forgejo.listWorkflowRuns(input.owner, input.repo, {
      ref,
      status: input.status,
      event: input.event,
      page: input.page,
      perPage: input.per_page,
    });
    return {
      items: result.items.map((r) => ({
        id: r.id,
        run_number: r.index_in_repo,
        title: r.title,
        workflow: r.workflow_id,
        status: r.status,
        event: r.event,
        ref: r.prettyref ?? null,
        sha: r.commit_sha,
        url: r.html_url,
        created_at: r.created,
        updated_at: r.updated,
      })),
      pagination: result.pagination,
    };
  },
});

export const getWorkflowRunJobs = defineTool({
  name: "get_workflow_run_jobs",
  description:
    "List the jobs of a workflow run (name, status, attempt, dependencies). Use a job's id with get_job_log.",
  schema: z.object({
    owner,
    repo,
    run_id: runId,
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const jobs = await ctx.forgejo
      .listWorkflowRunJobs(input.owner, input.repo, input.run_id)
      .catch((err) => explainMissingApi(ctx, err, "jobs", "workflow run jobs"));
    return {
      items: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        attempt: j.attempt,
        needs: j.needs ?? [],
        runs_on: j.runs_on ?? [],
      })),
    };
  },
});

export const getJobLog = defineTool({
  name: "get_job_log",
  description:
    "Fetch a Forgejo Actions job's log, ANSI-stripped. Returns a bounded slice (default the last 64 KiB; set from='start' for the head). total_bytes/truncated indicate whether more remains.",
  schema: z.object({
    owner,
    repo,
    job_id: z.number().int().positive().describe("Job id (from get_workflow_run_jobs)"),
    attempt: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based attempt number; omit for the latest attempt"),
    tail_bytes: z
      .number()
      .int()
      .min(1)
      .max(JOB_LOG_MAX_BYTES)
      .optional()
      .describe(`Max bytes to return (default ${JOB_LOG_DEFAULT_BYTES}, max ${JOB_LOG_MAX_BYTES})`),
    from: z
      .enum(["end", "start"])
      .optional()
      .describe("Which end of the log to slice: 'end' (default, the tail) or 'start' (the head)"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    const raw = await ctx.forgejo
      .getJobLog(input.owner, input.repo, input.job_id, input.attempt)
      .catch((err) => explainMissingApi(ctx, err, "logs", "job logs"));
    const log = cleanLog(raw);
    const from = input.from ?? "end";
    const maxBytes = input.tail_bytes ?? JOB_LOG_DEFAULT_BYTES;
    // Encode once; reuse the buffer for both the byte count and the slice.
    const buf = Buffer.from(log, "utf-8");
    const { slice, truncated } = sliceByBytes(log, maxBytes, from, buf);
    return {
      log: slice,
      from,
      truncated,
      returned_bytes: Buffer.byteLength(slice, "utf-8"),
      total_bytes: buf.length,
    };
  },
});

export const retryJob = defineTool({
  name: "retry_job",
  description:
    "Rerun a completed Forgejo Actions job (e.g. a failed one) and the jobs that depend on it, as the authenticated user. The job keeps its id; the rerun is a new attempt, which get_job_log returns by default. Requires Forgejo 17 or newer.",
  schema: z.object({
    owner,
    repo,
    job_id: z.number().int().positive().describe("Job id (from get_workflow_run_jobs)"),
  }),
  async handler(input, ctx) {
    await ctx.forgejo.assertRepoAccess(input.owner, input.repo);
    await ctx.forgejo
      .rerunJob(input.owner, input.repo, input.job_id)
      .catch((err) => explainMissingApi(ctx, err, "rerun", "job reruns"));
    const j = await ctx.forgejo.getWorkflowJob(input.owner, input.repo, input.job_id);
    return {
      id: j.id,
      run_id: j.run_id,
      name: j.name,
      status: j.status,
      attempt: j.attempt,
      url: j.html_url ?? null,
    };
  },
});

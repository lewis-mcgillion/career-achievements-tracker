import { Octokit } from "octokit";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { addMonths, format, startOfMonth, endOfMonth, isBefore, parseISO } from "date-fns";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
interface Args {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  repos: string[];   // ["owner/repo", ...]
  username: string;
  outputDir: string;
  token: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing required argument: ${flag}`);
    }
    return args[idx + 1];
  };

  const now = new Date();
  const lastMonth = addMonths(now, -1);

  return {
    startDate: get("--start-date", format(startOfMonth(lastMonth), "yyyy-MM-dd")),
    endDate: get("--end-date", format(endOfMonth(lastMonth), "yyyy-MM-dd")),
    repos: (process.env.TRACKED_REPOS ?? get("--repos")).split(",").map((r) => r.trim()),
    username: get("--username"),
    outputDir: get("--output-dir", "./data"),
    token: process.env.GITHUB_TOKEN ?? get("--token", ""),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthRanges(start: string, end: string): Array<{ year: string; month: string; since: string; until: string }> {
  const ranges: Array<{ year: string; month: string; since: string; until: string }> = [];
  let cursor = startOfMonth(parseISO(start));
  const last = parseISO(end);

  while (isBefore(cursor, last) || format(cursor, "yyyy-MM") === format(last, "yyyy-MM")) {
    const monthEnd = endOfMonth(cursor);
    ranges.push({
      year: format(cursor, "yyyy"),
      month: format(cursor, "MM"),
      since: cursor.toISOString(),
      until: monthEnd.toISOString(),
    });
    cursor = startOfMonth(addMonths(cursor, 1));
  }
  return ranges;
}

async function writeJson(dir: string, filename: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`      ✓ ${filename} (${Array.isArray(data) ? data.length : 0} items)`);
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

let _orgNames: string[] = [];
let _repoNames: string[] = [];
let _username: string = "";

function setRedactTargets(repos: string[], username: string): void {
  _orgNames = [...new Set(repos.map((r) => r.split("/")[0]))];
  _repoNames = [...new Set(repos.map((r) => r.split("/")[1]).filter(Boolean))];
  _username = username;
}

function sanitizeError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e.status) return `HTTP ${e.status}`;
  let msg = String(e.message ?? "unknown error");
  msg = msg.replace(/https?:\/\/[^\s]+/g, "[redacted-url]");
  msg = msg.replace(/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/g, "[redacted]");
  msg = msg.replace(/"owner":\s*"[^"]+"/g, '"owner":"[redacted]"');
  msg = msg.replace(/"repo":\s*"[^"]+"/g, '"repo":"[redacted]"');
  msg = msg.replace(/"repository":\s*"[^"]+"/g, '"repository":"[redacted]"');
  for (const name of [..._orgNames, ..._repoNames]) {
    if (name.length >= 3) {
      msg = msg.replace(new RegExp(`\\b${name}\\b`, "gi"), "[redacted]");
    }
  }
  if (_username && _username.length >= 3) {
    msg = msg.replace(new RegExp(`\\b${_username}\\b`, "gi"), "[redacted-user]");
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Resilient fetch with retries (5xx + rate limits)
// ---------------------------------------------------------------------------

async function safeFetch<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const maxRetries = 4;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { headers?: Record<string, string> } };
      const status = e.status ?? 0;

      // Retry on server errors (5xx)
      if (status >= 500 && attempt < maxRetries) {
        const waitMs = attempt * 15_000; // 15s, 30s, 45s
        console.warn(`      ⚠ ${label}: HTTP ${status}, retry ${attempt}/${maxRetries} in ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Rate limits (403/429)
      if (status === 403 || status === 429) {
        const resetHeader = e.response?.headers?.["x-ratelimit-reset"];
        const resetTime = resetHeader ? parseInt(resetHeader, 10) * 1000 : Date.now() + 60_000;
        const waitMs = Math.max(resetTime - Date.now(), 5_000);
        console.warn(`      ⏳ ${label}: rate limited, waiting ${Math.round(waitMs / 1000)}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        if (attempt < maxRetries) continue;
      }

      // Secondary rate limit (abuse detection) — often returned as 403 with retry-after
      const retryAfter = e.response?.headers?.["retry-after"];
      if (retryAfter && attempt < maxRetries) {
        const waitMs = parseInt(retryAfter, 10) * 1000 || 30_000;
        console.warn(`      ⏳ ${label}: retry-after ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      throw new Error(`${label}: ${sanitizeError(err)}`);
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}

// ---------------------------------------------------------------------------
// Search-based fetch functions (more efficient than listForRepo on large repos)
// ---------------------------------------------------------------------------

async function searchItems(
  octokit: Octokit, query: string, label: string
): Promise<unknown[]> {
  const items: unknown[] = [];
  let page = 1;
  while (true) {
    const resp = await octokit.rest.search.issuesAndPullRequests({
      q: query, per_page: 100, page, sort: "created", order: "asc",
    });
    items.push(...resp.data.items);
    console.log(`        ${label} page ${page}: ${resp.data.items.length} items (${items.length}/${resp.data.total_count} total)`);
    if (items.length >= resp.data.total_count || resp.data.items.length === 0) break;
    page++;
    // Pace ourselves — search API has a 30 req/min limit
    if (page % 3 === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  return items;
}

async function fetchIssuesCreated(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  const q = `repo:${owner}/${repo} is:issue is:closed reason:completed author:${username} created:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  return searchItems(octokit, q, "issues-created");
}

async function fetchIssuesAssigned(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  const q = `repo:${owner}/${repo} is:issue is:closed reason:completed assignee:${username} created:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  return searchItems(octokit, q, "issues-assigned");
}

async function fetchPRsCreated(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  const q = `repo:${owner}/${repo} is:pr is:merged author:${username} created:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  return searchItems(octokit, q, "prs-created");
}

async function fetchPRsAssigned(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  const q = `repo:${owner}/${repo} is:pr is:merged assignee:${username} created:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  return searchItems(octokit, q, "prs-assigned");
}

async function fetchPRReviews(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  // First find PRs the user reviewed, then fetch their actual reviews
  const q = `repo:${owner}/${repo} is:pr reviewed-by:${username} updated:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  const prItems = await searchItems(octokit, q, "pr-reviews-search");

  const reviews: unknown[] = [];
  for (const prItem of prItems) {
    const pr = prItem as { number: number };
    try {
      const prReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner, repo, pull_number: pr.number, per_page: 100,
      });
      for (const review of prReviews) {
        const r = review as { user?: { login?: string }; submitted_at?: string };
        if (
          r.user?.login === username &&
          r.submitted_at &&
          new Date(r.submitted_at) >= new Date(since) &&
          new Date(r.submitted_at) <= new Date(until)
        ) {
          reviews.push({ ...review, pull_number: pr.number });
        }
      }
    } catch {
      console.warn(`        ⚠ Could not fetch reviews for a PR, skipping`);
    }
  }
  console.log(`        pr-reviews: ${reviews.length} reviews from ${prItems.length} PRs`);
  return reviews;
}

async function fetchIssueComments(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  // Use search to find issues the user commented on, then fetch comments
  const q = `repo:${owner}/${repo} is:issue commenter:${username} updated:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  const issues = await searchItems(octokit, q, "issue-comments-search");

  const comments: unknown[] = [];
  for (const issue of issues) {
    const iss = issue as { number: number };
    try {
      const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner, repo, issue_number: iss.number, since, per_page: 100,
      });
      for (const comment of issueComments) {
        const c = comment as { user?: { login?: string }; created_at: string };
        const created = new Date(c.created_at);
        if (c.user?.login === username && created >= new Date(since) && created <= new Date(until)) {
          comments.push(comment);
        }
      }
    } catch {
      console.warn(`        ⚠ Could not fetch comments for an issue, skipping`);
    }
  }
  console.log(`        issue-comments: ${comments.length} comments from ${issues.length} issues`);
  return comments;
}

async function fetchPRComments(
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
): Promise<unknown[]> {
  // Use search to find PRs the user commented on, then fetch review comments
  const q = `repo:${owner}/${repo} is:pr commenter:${username} updated:${since.slice(0, 10)}..${until.slice(0, 10)}`;
  const prs = await searchItems(octokit, q, "pr-comments-search");

  const comments: unknown[] = [];
  for (const prItem of prs) {
    const pr = prItem as { number: number };
    try {
      const prComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner, repo, pull_number: pr.number, since, per_page: 100,
      });
      for (const comment of prComments) {
        const c = comment as { user?: { login?: string }; created_at: string };
        const created = new Date(c.created_at);
        if (c.user?.login === username && created >= new Date(since) && created <= new Date(until)) {
          comments.push(comment);
        }
      }
    } catch {
      console.warn(`        ⚠ Could not fetch comments for a PR, skipping`);
    }
  }
  console.log(`        pr-comments: ${comments.length} comments from ${prs.length} PRs`);
  return comments;
}

// ---------------------------------------------------------------------------
// Fetch type definitions for clean iteration
// ---------------------------------------------------------------------------

type FetchFn = (
  octokit: Octokit, owner: string, repo: string, username: string, since: string, until: string
) => Promise<unknown[]>;

const FETCH_TYPES: Array<{ name: string; filename: string; fn: FetchFn }> = [
  { name: "issues-created",  filename: "issues-created.json",  fn: fetchIssuesCreated },
  { name: "issues-assigned", filename: "issues-assigned.json", fn: fetchIssuesAssigned },
  { name: "prs-created",     filename: "prs-created.json",     fn: fetchPRsCreated },
  { name: "prs-assigned",    filename: "prs-assigned.json",    fn: fetchPRsAssigned },
  { name: "pr-reviews",      filename: "pr-reviews.json",      fn: fetchPRReviews },
  { name: "issue-comments",  filename: "issue-comments.json",  fn: fetchIssueComments },
  { name: "pr-comments",     filename: "pr-comments.json",     fn: fetchPRComments },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.token) {
    throw new Error("No GitHub token provided. Use --token or set GITHUB_TOKEN env var.");
  }

  const octokit = new Octokit({ auth: args.token });
  setRedactTargets(args.repos, args.username);

  // Verify authentication and check rate limit
  const { data: user } = await octokit.rest.users.getAuthenticated();
  console.log(`✓ Authenticated`);

  const { data: rateLimit } = await octokit.rest.rateLimit.get();
  console.log(`✓ Rate limit: ${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit} core, ${rateLimit.resources.search.remaining}/${rateLimit.resources.search.limit} search`);

  const ranges = monthRanges(args.startDate, args.endDate);
  console.log(`\nFetching data for ${ranges.length} month(s): ${ranges.map((r) => `${r.year}-${r.month}`).join(", ")}`);
  console.log(`Repos: ${args.repos.length} repo(s)\n`);

  let totalErrors = 0;

  for (const range of ranges) {
    const monthLabel = `${range.year}-${range.month}`;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📅 ${monthLabel}`);
    console.log(`${"=".repeat(60)}`);

    const monthDir = join(args.outputDir, monthLabel);

    // Per-type accumulators
    const accumulated: Record<string, unknown[]> = {};
    for (const ft of FETCH_TYPES) accumulated[ft.name] = [];

    for (const repoFull of args.repos) {
      const [owner, repo] = repoFull.split("/");
      const repoIndex = args.repos.indexOf(repoFull) + 1;
      console.log(`\n  📦 Repo ${repoIndex}/${args.repos.length}`);

      for (const ft of FETCH_TYPES) {
        console.log(`    → ${ft.name}`);
        try {
          const items = await safeFetch(ft.name, () =>
            ft.fn(octokit, owner, repo, args.username, range.since, range.until)
          );
          const tagged = items.map((i) => ({ ...i as object, _source_repo: repoFull }));
          accumulated[ft.name].push(...tagged);
          console.log(`    ✓ ${ft.name}: ${items.length} items`);
        } catch (err) {
          totalErrors++;
          const msg = err instanceof Error ? err.message : "unknown error";
          console.warn(`    ✗ ${ft.name}: FAILED — ${msg}`);
        }

        // Brief pause between fetch types to be nice to the API
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Write all data files for this month
    for (const ft of FETCH_TYPES) {
      await writeJson(monthDir, ft.filename, accumulated[ft.name]);
    }

    console.log(`\n  📊 ${monthLabel} totals:`);
    for (const ft of FETCH_TYPES) {
      console.log(`     ${ft.name.padEnd(18)} ${accumulated[ft.name].length}`);
    }
  }

  // Final summary
  if (totalErrors > 0) {
    console.log(`\n⚠ Completed with ${totalErrors} failed fetch(es). Some data may be incomplete.`);
  } else {
    console.log(`\n✅ Done! All fetches succeeded.`);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : "unknown error";
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});

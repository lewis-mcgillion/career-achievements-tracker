import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
interface Args {
  dataDir: string;     // path to career-data/data/
  achievementsDir: string; // path to career-data/achievements/
  months: string[];    // ["2025-01", "2025-02", ...] — empty = all
  force: boolean;      // regenerate even if file exists
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

  const monthsRaw = get("--months", "");
  return {
    dataDir: get("--data-dir"),
    achievementsDir: get("--achievements-dir"),
    months: monthsRaw ? monthsRaw.split(",").map((m) => m.trim()) : [],
    force: args.includes("--force"),
  };
}

// ---------------------------------------------------------------------------
// Types for parsed data
// ---------------------------------------------------------------------------
interface ActivityItem {
  title?: string;
  body?: string;
  state?: string;
  state_reason?: string;
  merged_at?: string;
  created_at?: string;
  pull_request?: { merged_at?: string };
  labels?: Array<{ name?: string }>;
  _source_repo?: string;
}

interface ReviewItem {
  state?: string;
  body?: string;
  pull_number?: number;
  submitted_at?: string;
  _source_repo?: string;
}

interface CommentItem {
  body?: string;
  created_at?: string;
  _source_repo?: string;
  html_url?: string;
}

// ---------------------------------------------------------------------------
// Sanitization — strip internal details
// ---------------------------------------------------------------------------
const INTERNAL_PATTERNS = [
  /github\/[a-zA-Z0-9_.-]+/gi,
  /\b[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\b/g, // org/repo patterns
  /#\d{3,}/g,                               // issue/PR numbers
  /https?:\/\/github\.com\/[^\s)]+/gi,      // GitHub URLs
];

function sanitize(text: string): string {
  let s = text;
  for (const pat of INTERNAL_PATTERNS) {
    s = s.replace(pat, "");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

// Map _source_repo to a generic area description
function repoToArea(repo: string): string {
  const name = repo.split("/").pop()?.toLowerCase() ?? "";
  // Generic mapping — avoids leaking real repo names
  const areas: Record<string, string> = {
    github: "core platform",
    "copilot-api": "AI developer tools API",
    "github-ui": "platform UI",
    "copilot-experiences": "AI developer experiences",
    authzd: "authorization services",
    "copilot-chat": "AI chat features",
  };
  return areas[name] ?? "platform services";
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadJson<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Theme extraction — group work into meaningful categories
// ---------------------------------------------------------------------------
interface ThemeGroup {
  area: string;
  items: string[];
}

function extractThemes(items: ActivityItem[]): ThemeGroup[] {
  const byArea = new Map<string, string[]>();

  for (const item of items) {
    const area = repoToArea(item._source_repo ?? "");
    const title = item.title ?? "untitled";
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area)!.push(sanitize(title));
  }

  return Array.from(byArea.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([area, items]) => ({ area, items }));
}

// Deduplicate titles that are very similar (e.g., same PR in created + assigned)
function dedup(titles: string[]): string[] {
  const seen = new Set<string>();
  return titles.filter((t) => {
    const key = t.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------
function monthName(ym: string): string {
  const [y, m] = ym.split("-");
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

function generateMonthlyMarkdown(
  month: string,
  issuesCreated: ActivityItem[],
  issuesAssigned: ActivityItem[],
  prsCreated: ActivityItem[],
  prsAssigned: ActivityItem[],
  prReviews: ReviewItem[],
  issueComments: CommentItem[],
  prComments: CommentItem[],
): string {
  const lines: string[] = [];
  const allPrs = [...prsCreated, ...prsAssigned];
  const allIssues = [...issuesCreated, ...issuesAssigned];
  const totalComments = issueComments.length + prComments.length;

  lines.push(`# ${monthName(month)}`);
  lines.push("");

  // --- Impact ---
  lines.push("## Impact");
  lines.push("");

  const prThemes = extractThemes(allPrs);
  const issueThemes = extractThemes(allIssues);

  if (prThemes.length === 0 && issueThemes.length === 0) {
    lines.push("_No merged PRs or completed issues this month._");
  } else {
    // Summarize top areas of work
    const allAreas = new Map<string, number>();
    for (const t of [...prThemes, ...issueThemes]) {
      allAreas.set(t.area, (allAreas.get(t.area) ?? 0) + t.items.length);
    }
    const topAreas = Array.from(allAreas.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);

    for (const [area, count] of topAreas) {
      lines.push(`- Contributed to **${area}** (${count} item${count !== 1 ? "s" : ""})`);
    }
  }
  lines.push("");

  // --- Highlights ---
  lines.push("## Highlights");
  lines.push("");
  // Pick top 3 PRs by title length as a proxy for "substantial work"
  const topPrs = dedup(
    allPrs
      .sort((a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0))
      .map((p) => sanitize(p.title ?? ""))
  ).slice(0, 3);

  if (topPrs.length > 0) {
    for (const title of topPrs) {
      lines.push(`- ${title}`);
    }
  } else {
    lines.push("_No notable highlights this month._");
  }
  lines.push("");

  // --- PRs & Code ---
  lines.push("## PRs & Code");
  lines.push("");
  if (allPrs.length === 0) {
    lines.push("_No merged PRs this month._");
  } else {
    for (const theme of prThemes) {
      lines.push(`### ${theme.area}`);
      lines.push("");
      const titles = dedup(theme.items).slice(0, 10);
      for (const t of titles) {
        lines.push(`- ${t}`);
      }
      if (theme.items.length > 10) {
        lines.push(`- _...and ${theme.items.length - 10} more_`);
      }
      lines.push("");
    }
  }

  // --- Reviews ---
  lines.push("## Reviews");
  lines.push("");
  if (prReviews.length === 0) {
    lines.push("_No PR reviews this month._");
  } else {
    // Group reviews by area
    const reviewAreas = new Map<string, number>();
    for (const r of prReviews) {
      const area = repoToArea(r._source_repo ?? "");
      reviewAreas.set(area, (reviewAreas.get(area) ?? 0) + 1);
    }
    for (const [area, count] of Array.from(reviewAreas.entries()).sort((a, b) => b[1] - a[1])) {
      lines.push(`- Reviewed ${count} PR${count !== 1 ? "s" : ""} in **${area}**`);
    }
  }
  lines.push("");

  // --- Issues ---
  lines.push("## Issues");
  lines.push("");
  if (allIssues.length === 0) {
    lines.push("_No completed issues this month._");
  } else {
    for (const theme of issueThemes) {
      lines.push(`### ${theme.area}`);
      lines.push("");
      const titles = dedup(theme.items).slice(0, 10);
      for (const t of titles) {
        lines.push(`- ${t}`);
      }
      if (theme.items.length > 10) {
        lines.push(`- _...and ${theme.items.length - 10} more_`);
      }
      lines.push("");
    }
  }

  // --- Collaboration ---
  lines.push("## Collaboration");
  lines.push("");
  if (totalComments === 0) {
    lines.push("_No comments this month._");
  } else {
    const commentAreas = new Map<string, number>();
    for (const c of [...issueComments, ...prComments]) {
      const area = repoToArea(c._source_repo ?? "");
      commentAreas.set(area, (commentAreas.get(area) ?? 0) + 1);
    }
    for (const [area, count] of Array.from(commentAreas.entries()).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${count} comment${count !== 1 ? "s" : ""} on **${area}**`);
    }
  }
  lines.push("");

  // --- Numbers ---
  lines.push("## Numbers");
  lines.push("");
  lines.push("| | Count |");
  lines.push("|---|---|");
  lines.push(`| PRs merged | ${allPrs.length} |`);
  lines.push(`| PRs reviewed | ${prReviews.length} |`);
  lines.push(`| Issues completed | ${allIssues.length} |`);
  lines.push(`| Comments | ${totalComments} |`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SUMMARY.md generation
// ---------------------------------------------------------------------------
interface AreaBreakdown {
  area: string;
  prs: number;
  reviews: number;
  issues: number;
  comments: number;
  prTitles: string[];
  issueTitles: string[];
}

interface MonthSummary {
  month: string;
  prs: number;
  reviews: number;
  issues: number;
  comments: number;
  areas: AreaBreakdown[];
}

function generateSummaryMarkdown(summaries: MonthSummary[]): string {
  const lines: string[] = [];
  lines.push("# Career Achievements Summary");
  lines.push("");
  lines.push("Auto-generated overview of monthly contributions.");
  lines.push("");

  const sorted = summaries.sort((a, b) => a.month.localeCompare(b.month));
  const totalPrs = sorted.reduce((a, s) => a + s.prs, 0);
  const totalReviews = sorted.reduce((a, s) => a + s.reviews, 0);
  const totalIssues = sorted.reduce((a, s) => a + s.issues, 0);
  const totalComments = sorted.reduce((a, s) => a + s.comments, 0);
  const totalActivity = totalPrs + totalReviews + totalIssues + totalComments;
  const firstMonth = sorted[0]?.month ?? "N/A";
  const lastMonth = sorted[sorted.length - 1]?.month ?? "N/A";

  // --- Key Achievements overview ---
  lines.push("## Key Achievements");
  lines.push("");
  lines.push(`Over **${sorted.length} months** (${monthName(firstMonth)} – ${monthName(lastMonth)}), ` +
    `contributed **${totalActivity.toLocaleString()} activities** across the platform:`);
  lines.push("");

  // Aggregate areas across all months
  const globalAreas = new Map<string, AreaBreakdown>();
  for (const s of sorted) {
    for (const a of s.areas) {
      const existing = globalAreas.get(a.area);
      if (existing) {
        existing.prs += a.prs;
        existing.reviews += a.reviews;
        existing.issues += a.issues;
        existing.comments += a.comments;
        existing.prTitles.push(...a.prTitles);
        existing.issueTitles.push(...a.issueTitles);
      } else {
        globalAreas.set(a.area, {
          area: a.area,
          prs: a.prs,
          reviews: a.reviews,
          issues: a.issues,
          comments: a.comments,
          prTitles: [...a.prTitles],
          issueTitles: [...a.issueTitles],
        });
      }
    }
  }

  const rankedAreas = Array.from(globalAreas.values())
    .map((a) => ({ ...a, total: a.prs + a.reviews + a.issues + a.comments }))
    .sort((a, b) => b.total - a.total);

  // Top areas of contribution
  for (const area of rankedAreas) {
    const pct = Math.round((area.total / totalActivity) * 100);
    lines.push(`- **${area.area}** — ${area.total} contributions (${pct}%): ` +
      `${area.prs} PRs, ${area.reviews} reviews, ${area.issues} issues, ${area.comments} comments`);
  }
  lines.push("");

  // Busiest and most productive months
  const byTotal = [...sorted].sort((a, b) =>
    (b.prs + b.reviews + b.issues + b.comments) - (a.prs + a.reviews + a.issues + a.comments)
  );
  const busiestMonth = byTotal[0];
  if (busiestMonth) {
    const bTotal = busiestMonth.prs + busiestMonth.reviews + busiestMonth.issues + busiestMonth.comments;
    lines.push(`**Busiest month:** ${monthName(busiestMonth.month)} with ${bTotal} total contributions`);
    lines.push("");
  }

  // Highlight top shipped work per area
  lines.push("### Top Contributions by Area");
  lines.push("");
  for (const area of rankedAreas.slice(0, 5)) {
    lines.push(`#### ${area.area}`);
    lines.push("");
    const topPrTitles = dedup(area.prTitles).slice(0, 5);
    const topIssueTitles = dedup(area.issueTitles).slice(0, 3);

    if (topPrTitles.length > 0) {
      lines.push("**PRs shipped:**");
      for (const t of topPrTitles) lines.push(`- ${t}`);
      if (area.prs > 5) lines.push(`- _...and ${area.prs - 5} more PRs_`);
      lines.push("");
    }
    if (topIssueTitles.length > 0) {
      lines.push("**Issues completed:**");
      for (const t of topIssueTitles) lines.push(`- ${t}`);
      if (area.issues > 3) lines.push(`- _...and ${area.issues - 3} more issues_`);
      lines.push("");
    }
  }

  // --- All-Time Totals ---
  lines.push("## All-Time Totals");
  lines.push("");
  lines.push("| | Count |");
  lines.push("|---|---|");
  lines.push(`| PRs merged | ${totalPrs} |`);
  lines.push(`| PRs reviewed | ${totalReviews} |`);
  lines.push(`| Issues completed | ${totalIssues} |`);
  lines.push(`| Comments | ${totalComments} |`);
  lines.push("");

  // --- Area Breakdown ---
  lines.push("## Contribution by Area");
  lines.push("");
  lines.push("| Area | PRs | Reviews | Issues | Comments | Total |");
  lines.push("|---|---|---|---|---|---|");
  for (const area of rankedAreas) {
    lines.push(`| ${area.area} | ${area.prs} | ${area.reviews} | ${area.issues} | ${area.comments} | ${area.total} |`);
  }
  lines.push("");

  // --- Monthly Breakdown ---
  lines.push("## Monthly Breakdown");
  lines.push("");
  lines.push("| Month | PRs | Reviews | Issues | Comments |");
  lines.push("|---|---|---|---|---|");

  for (const s of [...sorted].reverse()) {
    lines.push(`| [${monthName(s.month)}](${s.month}.md) | ${s.prs} | ${s.reviews} | ${s.issues} | ${s.comments} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// Load area breakdowns from a month's data directory
async function loadAreasFromData(dataPath: string): Promise<AreaBreakdown[]> {
  if (!existsSync(dataPath)) return [];
  const [prsCreated, prsAssigned, prReviews, issuesCreated, issuesAssigned, issueComments, prComments] =
    await Promise.all([
      loadJson<ActivityItem>(join(dataPath, "prs-created.json")),
      loadJson<ActivityItem>(join(dataPath, "prs-assigned.json")),
      loadJson<ReviewItem>(join(dataPath, "pr-reviews.json")),
      loadJson<ActivityItem>(join(dataPath, "issues-created.json")),
      loadJson<ActivityItem>(join(dataPath, "issues-assigned.json")),
      loadJson<CommentItem>(join(dataPath, "issue-comments.json")),
      loadJson<CommentItem>(join(dataPath, "pr-comments.json")),
    ]);
  return buildAreaBreakdowns(
    [...prsCreated, ...prsAssigned],
    prReviews,
    [...issuesCreated, ...issuesAssigned],
    [...issueComments, ...prComments],
  );
}

// Build area breakdowns from raw data for use in the overall summary
function buildAreaBreakdowns(
  prs: ActivityItem[],
  reviews: ReviewItem[],
  issues: ActivityItem[],
  comments: CommentItem[],
): AreaBreakdown[] {
  const areas = new Map<string, AreaBreakdown>();

  const getArea = (repo: string): AreaBreakdown => {
    const area = repoToArea(repo);
    if (!areas.has(area)) {
      areas.set(area, { area, prs: 0, reviews: 0, issues: 0, comments: 0, prTitles: [], issueTitles: [] });
    }
    return areas.get(area)!;
  };

  for (const pr of prs) {
    const a = getArea(pr._source_repo ?? "");
    a.prs++;
    if (pr.title) a.prTitles.push(sanitize(pr.title));
  }
  for (const r of reviews) {
    getArea(r._source_repo ?? "").reviews++;
  }
  for (const iss of issues) {
    const a = getArea(iss._source_repo ?? "");
    a.issues++;
    if (iss.title) a.issueTitles.push(sanitize(iss.title));
  }
  for (const c of comments) {
    getArea(c._source_repo ?? "").comments++;
  }

  return Array.from(areas.values());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs();

  // Discover available months
  let monthDirs: string[];
  if (args.months.length > 0) {
    monthDirs = args.months;
  } else {
    // Auto-discover from data directory
    const entries = await readdir(args.dataDir, { withFileTypes: true });
    monthDirs = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  if (monthDirs.length === 0) {
    console.log("No month directories found. Nothing to generate.");
    return;
  }

  console.log(`\nGenerating achievements for ${monthDirs.length} month(s): ${monthDirs.join(", ")}\n`);
  await mkdir(args.achievementsDir, { recursive: true });

  const summaries: MonthSummary[] = [];
  let generated = 0;
  let skipped = 0;

  for (const month of monthDirs) {
    const achievementFile = join(args.achievementsDir, `${month}.md`);

    // Skip if already exists and not forcing
    if (!args.force && existsSync(achievementFile)) {
      console.log(`  ⏭  ${month} — already exists, skipping (use --force to regenerate)`);
      // Load raw data to include area breakdowns in summary
      const dataPath = join(args.dataDir, month);
      const areas = await loadAreasFromData(dataPath);
      const existing = await readFile(achievementFile, "utf-8");
      const nums = parseNumbersFromMarkdown(existing);
      summaries.push({ month, ...nums, areas });
      skipped++;
      continue;
    }

    const dataPath = join(args.dataDir, month);
    if (!existsSync(dataPath)) {
      console.log(`  ⚠  ${month} — no data directory, skipping`);
      continue;
    }

    // Load all data files
    const [
      issuesCreated, issuesAssigned,
      prsCreated, prsAssigned,
      prReviews,
      issueComments, prComments,
    ] = await Promise.all([
      loadJson<ActivityItem>(join(dataPath, "issues-created.json")),
      loadJson<ActivityItem>(join(dataPath, "issues-assigned.json")),
      loadJson<ActivityItem>(join(dataPath, "prs-created.json")),
      loadJson<ActivityItem>(join(dataPath, "prs-assigned.json")),
      loadJson<ReviewItem>(join(dataPath, "pr-reviews.json")),
      loadJson<CommentItem>(join(dataPath, "issue-comments.json")),
      loadJson<CommentItem>(join(dataPath, "pr-comments.json")),
    ]);

    const md = generateMonthlyMarkdown(
      month,
      issuesCreated, issuesAssigned,
      prsCreated, prsAssigned,
      prReviews,
      issueComments, prComments,
    );

    await writeFile(achievementFile, md, "utf-8");
    console.log(`  ✅ ${month} — generated`);
    generated++;

    const allPrs = [...prsCreated, ...prsAssigned];
    const allIssues = [...issuesCreated, ...issuesAssigned];
    summaries.push({
      month,
      prs: allPrs.length,
      reviews: prReviews.length,
      issues: allIssues.length,
      comments: issueComments.length + prComments.length,
      areas: buildAreaBreakdowns(allPrs, prReviews, allIssues, [...issueComments, ...prComments]),
    });
  }

  // Also load existing achievement files not in our list (for full summary)
  try {
    const existingFiles = await readdir(args.achievementsDir);
    for (const file of existingFiles) {
      const match = file.match(/^(\d{4}-\d{2})\.md$/);
      if (match && !monthDirs.includes(match[1])) {
        const content = await readFile(join(args.achievementsDir, file), "utf-8");
        const nums = parseNumbersFromMarkdown(content);
        const dataPath = join(args.dataDir, match[1]);
        const areas = await loadAreasFromData(dataPath);
        summaries.push({ month: match[1], ...nums, areas });
      }
    }
  } catch {
    // achievements dir might not have other files
  }

  // Generate SUMMARY.md
  const summaryMd = generateSummaryMarkdown(summaries);
  await writeFile(join(args.achievementsDir, "SUMMARY.md"), summaryMd, "utf-8");
  console.log(`\n📊 SUMMARY.md updated`);

  console.log(`\n✅ Done! Generated: ${generated}, Skipped: ${skipped}`);
}

// Parse numbers from an existing achievement markdown file
function parseNumbersFromMarkdown(content: string): { prs: number; reviews: number; issues: number; comments: number } {
  const getNum = (label: string): number => {
    const match = content.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`));
    return match ? parseInt(match[1], 10) : 0;
  };
  return {
    prs: getNum("PRs merged"),
    reviews: getNum("PRs reviewed"),
    issues: getNum("Issues completed"),
    comments: getNum("Comments"),
  };
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});

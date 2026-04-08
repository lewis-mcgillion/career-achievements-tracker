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
interface DiffFileStats {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

interface DiffStats {
  additions: number;
  deletions: number;
  changed_files: number;
  files: DiffFileStats[];
}

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
  _diff_stats?: DiffStats;
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
// Description extraction — pull impact from PR/issue bodies
// ---------------------------------------------------------------------------

// Patterns to strip from bodies (boilerplate, template noise, links)
const BODY_NOISE_PATTERNS = [
  /closes?\s+https?:\/\/[^\s)]+/gi,
  /related?\s+https?:\/\/[^\s)]+/gi,
  /part\s+of\s+https?:\/\/[^\s)]+/gi,
  /fixes?\s+https?:\/\/[^\s)]+/gi,
  /https?:\/\/[^\s)>]+/gi,
  /<!--[\s\S]*?-->/g,
  /<img[^>]*\/?>/gi,
  /<details[\s\S]*?<\/details>/gi,     // collapsed sections
  /!\[[^\]]*\]\([^)]*\)/g,            // markdown images
  /^#+\s*(what approach|which feature flag|which environment|screenshot|test plan|rollout|rollback|how to test|how did you test|deploy notes|risk|additional context|checklist|corresponding work|description of change|tracking issue|link to any feature flag|type of change|motivation|context|pre[- ]?merge|post[- ]?merge|merge requirements|deploy).*$/gim,
  /^>\s*(if you are adding|note:|warning:|important:)/gim,  // template callouts
  /^-\s*\[[ x]\]\s*.*/gim,           // checklist items
  /^\s*-\s*Production:.*$/gim,        // deployment targets
  /^\s*-\s*Staging:.*$/gim,
  /^\s*<!--.*-->.*$/gm,
  /\*\*(low|medium|high)\s*risk:?\*\*[^.\n]*\.?/gi,
  /- Changes are fully under feature flag.*$/gim,
  /- This change will be tested.*$/gim,
  /- I ran `?UI=1.*$/gim,
  /\*\*[A-Z][a-z]+:\*\*/g,
  /`environment:[^`]+`/g,
  /`[^`]*feature[_-]flag[^`]*`/g,
  /\(#\d+\)/g,
  /#\d{3,}/g,
  /\b(cc|ping|fyi)\b\s*@\w+/gi,
  /@[a-zA-Z0-9_-]+/g,
  /\bPlease remember to add.*$/gim,    // issue template reminder
  /\b(Triaged by|reported by):?\s*/gi,
  /\bvia\s*\.\s*/gi,
  /\bShortly,\s+will provide.*$/gim,
  /\bBelow is the.*$/gim,
  /If you are adding a feature flag.*$/gim,
  /the owning service be\b.*$/gim,
  /otherwise\s+\w+\s+will not be able to capture.*$/gim,
  /a feature flag to CAPI.*$/gim,
  /configured within the list of services.*$/gim,
  /Sampling metrics at a rate less than.*$/gim,
  /Reducing cardinality of metric tags.*$/gim,
  /- Non-production$/gim,
];

// Internal identifiers to redact
const REDACT_PATTERNS = [
  /\b[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\b/g, // org/repo
  /\bcopilot[_-](?:[a-zA-Z0-9]+[_-])*[a-zA-Z0-9]+\b/gi, // feature flag names (copilot_foo_bar, copilot-chat-x-y)
  /\b(devportal|githubapp|dotcom)\b/gi,
];

function extractDescription(body: string | undefined, maxLen = 200): string {
  if (!body || body.length < 10) return "";

  let text = body;

  // Remove noise
  for (const pat of BODY_NOISE_PATTERNS) {
    text = text.replace(pat, "");
  }

  // Split into lines, filter meaningful ones
  const lines = text.split("\n")
    .map((l) => l.trim())
    .filter((l) =>
      l.length > 15 &&
      !l.startsWith("#") &&
      !l.startsWith("|") &&
      !l.startsWith("```") &&
      !l.startsWith("- [ ]") &&
      !l.startsWith("- [x]") &&
      !l.startsWith("Co-authored") &&
      !l.startsWith(">") &&
      !l.match(/^[-*]\s*$/) &&
      !l.match(/^\s*$/) &&
      !l.match(/^_link to/i) &&
      !l.match(/^please remember/i) &&
      !l.match(/^\*\*screenshot/i) &&
      !l.match(/^<details/i) &&
      !l.match(/^<summary/i) &&
      !l.match(/^<\/details/i) &&
      !l.match(/^> \[!/i) &&
      !l.match(/^(before|after)\s*[:(/]/i) &&
      !l.match(/^looks like this/i) &&      // dangling image reference
      !l.match(/^see (below|above|image)/i) &&
      !l.match(/^-\s*-\s*/i) &&            // double dash lists (template noise)
      !l.match(/^if you are adding/i) &&
      !l.match(/^the owning service/i)
    );

  if (lines.length === 0) return "";

  // Take first 1-2 meaningful lines as the description
  let desc = lines.slice(0, 2).join(" ").trim();

  // Convert markdown links to text FIRST so redaction can see clean identifiers
  desc = desc
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links → text only
    .replace(/\[([^\]]*)\]\(\)/g, "$1")       // empty links → text only
    .replace(/https?:\/\/[^\s)>]+/gi, "");    // strip remaining URLs

  // Clean up internal references
  for (const pat of REDACT_PATTERNS) {
    desc = desc.replace(pat, "");
  }

  // Clean up leftover artifacts
  desc = desc
    .replace(/<[^>]+>/g, "")           // any remaining HTML tags
    .replace(/\*\*[^*]*\*\*/g, "")     // bold markers with content (risk labels etc)
    .replace(/\*\*/g, "")              // orphan bold markers
    .replace(/`([^`]+)`/g, "$1")        // inline code → plain text
    .replace(/\s*-\s*-\s*/g, ". ")      // double dash separators → period
    .replace(/\.\s*\./g, ".")           // double periods
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*[-–—:,.\s]+/, "")     // leading punctuation
    .replace(/\s*[-–—]\s*$/, "")
    .replace(/:\s*$/g, "")              // trailing colons (from stripped images)
    .trim();

  if (desc.length < 15) return "";

  // Final pass: remove common PR template fragments that survive earlier cleanup
  desc = desc
    .replace(/\ba feature flag to \w+,?\s*the owning service be\b.*/gi, "")
    .replace(/\bconfigured within the list of services\b.*/gi, "")
    .replace(/\s*,\s*$/, "") // trailing comma
    .replace(/\s+(based on|depending on|according to|related to|closes|fixes|resolves)\s*$/gi, "") // dangling prepositions
    .replace(/\s{2,}/g, " ")
    .trim();

  if (desc.length < 15) return "";
  if (desc.length > maxLen) desc = desc.slice(0, maxLen).replace(/\s\S*$/, "…");

  return desc;
}

// Build a rich description line: title + context from body + diff stats
function buildItemLine(item: ActivityItem): string {
  const title = sanitize(item.title ?? "untitled");
  const desc = extractDescription(item.body);
  const diffTag = formatDiffTag(item._diff_stats);

  const parts: string[] = [`**${title}**`];
  if (desc) {
    const descCap = desc.charAt(0).toUpperCase() + desc.slice(1);
    parts.push(`— ${descCap}`);
  }
  if (diffTag) parts.push(diffTag);
  return parts.join(" ");
}

// Format a compact diff stats tag like "(+60/-3, 3 files)"
function formatDiffTag(stats?: DiffStats): string {
  if (!stats || (stats.additions === 0 && stats.deletions === 0)) return "";
  return `(+${stats.additions}/-${stats.deletions}, ${stats.changed_files} file${stats.changed_files !== 1 ? "s" : ""})`;
}

// Detect primary languages/technologies from diff file extensions
function detectTechnologies(prs: ActivityItem[]): Map<string, number> {
  const extMap: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".rb": "Ruby", ".go": "Go", ".py": "Python", ".rs": "Rust",
    ".css": "CSS", ".scss": "SCSS", ".html": "HTML", ".erb": "ERB",
    ".yml": "YAML", ".yaml": "YAML", ".json": "JSON",
    ".sql": "SQL", ".sh": "Shell", ".bash": "Shell",
    ".swift": "Swift", ".kt": "Kotlin", ".java": "Java",
    ".md": "Markdown",
  };

  const techChanges = new Map<string, number>();
  for (const pr of prs) {
    const files = pr._diff_stats?.files ?? [];
    for (const f of files) {
      const ext = f.filename.match(/\.[^./]+$/)?.[0]?.toLowerCase() ?? "";
      const tech = extMap[ext];
      if (tech && tech !== "Markdown" && tech !== "JSON" && tech !== "YAML") {
        techChanges.set(tech, (techChanges.get(tech) ?? 0) + f.additions + f.deletions);
      }
    }
  }
  return techChanges;
}

// Compute aggregate diff stats across all PRs
function aggregateDiffStats(prs: ActivityItem[]): {
  totalAdditions: number; totalDeletions: number; totalFiles: number;
  topFiles: Array<{ filename: string; additions: number; deletions: number }>;
} {
  let totalAdditions = 0, totalDeletions = 0, totalFiles = 0;
  const fileChanges = new Map<string, { additions: number; deletions: number }>();

  for (const pr of prs) {
    const stats = pr._diff_stats;
    if (!stats) continue;
    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;
    totalFiles += stats.changed_files;
    for (const f of stats.files) {
      const existing = fileChanges.get(f.filename) ?? { additions: 0, deletions: 0 };
      existing.additions += f.additions;
      existing.deletions += f.deletions;
      fileChanges.set(f.filename, existing);
    }
  }

  const topFiles = Array.from(fileChanges.entries())
    .sort((a, b) => (b[1].additions + b[1].deletions) - (a[1].additions + a[1].deletions))
    .slice(0, 10)
    .map(([filename, stats]) => ({ filename: sanitizeFilePath(filename), ...stats }));

  return { totalAdditions, totalDeletions, totalFiles, topFiles };
}

// Strip org/repo/internal details from file paths, keeping only the meaningful parts
function sanitizeFilePath(filePath: string): string {
  // Keep only the last 2-3 path segments for readability
  const parts = filePath.split("/");
  if (parts.length <= 3) return parts.join("/");
  return "…/" + parts.slice(-3).join("/");
}

// Clean a comment body for display — strip noise, URLs, images, short results
function cleanCommentBody(raw: string, maxLen = 200): string {
  let body = raw;
  // Remove URLs, images, HTML, markdown links
  body = body.replace(/https?:\/\/[^\s)>]+/gi, "");
  body = body.replace(/<img[^>]*\/?>/gi, "");
  body = body.replace(/<[^>]+>/g, "");
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  body = body.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, "$1"));
  body = body.replace(/@[a-zA-Z0-9_-]+/g, "");
  body = body.replace(/\b[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\b/g, "");
  body = body.replace(/#\d{3,}/g, "");
  body = body.replace(/`([^`]+)`/g, "$1");
  body = body.replace(/\s{2,}/g, " ").trim();
  if (body.length > maxLen) body = body.slice(0, maxLen).replace(/\s\S*$/, "…");
  return body;
}

// ---------------------------------------------------------------------------
// Impact scoring — rank items by actual career-advancement value
// ---------------------------------------------------------------------------

// Items that are low-effort and should be ranked lower
const LOW_IMPACT_PATTERNS = [
  /^graduate feature flag/i,
  /^remove feature flag/i,
  /^remove code for feature flag/i,
  /^revert\b/i,
  /^bump\b/i,
  /^update (readme|changelog|license)/i,
  /^fix typo/i,
  /^css (change|fix) for/i,
  /^minor\b/i,
];

function scoreItem(item: ActivityItem): number {
  const title = item.title ?? "";
  const diff = item._diff_stats;
  const descLen = extractDescription(item.body).length;

  // Base: description richness (0-200)
  let score = Math.min(descLen, 200);

  // Diff size bonus (capped to avoid outliers like auto-generated code)
  if (diff) {
    const totalLines = diff.additions + diff.deletions;
    // Sweet spot: 50-500 lines = meaningful work. Over 1000 = diminishing returns
    score += Math.min(totalLines, 500) * 0.3;
    // Bonus for touching many files (indicates cross-cutting work)
    score += Math.min(diff.changed_files, 20) * 5;
  }

  // Penalty for low-impact patterns
  if (LOW_IMPACT_PATTERNS.some((p) => p.test(title))) {
    score *= 0.1;
  }

  // Bonus for high-value keywords in title
  const highValueKeywords = [
    "performance", "optimize", "cache", "latency", "security",
    "pagination", "scale", "architecture", "api", "implement",
    "redesign", "error handling", "validation", "telemetry",
  ];
  if (highValueKeywords.some((kw) => title.toLowerCase().includes(kw))) {
    score *= 1.3;
  }

  return score;
}

// Group items by work theme (not repo) using title/body analysis
interface WorkTheme {
  label: string;
  keywords: string[];
}

const WORK_THEMES: WorkTheme[] = [
  { label: "Security & access control", keywords: ["security", "bounty", "vulnerability", "injection", "xss", "csrf", "permission", "access control", "policy", "authz"] },
  { label: "Performance & scalability", keywords: ["performance", "optimize", "cache", "speed", "latency", "pagination", "scale", "batch"] },
  { label: "Accessibility", keywords: ["accessibility", "a11y", "keyboard", "screen reader", "aria", "focus", "wcag"] },
  { label: "Observability & debugging", keywords: ["debug", "log", "monitor", "trace", "observ", "metric", "telemetry"] },
  { label: "New features", keywords: ["implement", "add", "create", "new", "introduce", "ship", "launch", "enable"] },
  { label: "Bug fixes & reliability", keywords: ["fix", "bug", "broken", "regression", "resolve", "error handling", "retry", "resilience"] },
  { label: "UX improvements", keywords: ["ux", "usability", "truncat", "overflow", "responsive", "viewport", "layout", "styling", "modal", "dialog", "tooltip", "placeholder"] },
  { label: "Code quality & maintenance", keywords: ["refactor", "cleanup", "deprecat", "migrate", "tech debt"] },
];

function detectItemTheme(item: ActivityItem): string {
  const title = (item.title ?? "").toLowerCase();
  for (const theme of WORK_THEMES) {
    if (theme.keywords.some((kw) => title.includes(kw))) return theme.label;
  }
  return "General engineering";
}

// ---------------------------------------------------------------------------
// Markdown generation — Monthly
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
  const allPrs = dedup_items([...prsCreated, ...prsAssigned]);
  const allIssues = dedup_items([...issuesCreated, ...issuesAssigned]);
  const totalComments = issueComments.length + prComments.length;

  lines.push(`# ${monthName(month)}`);
  lines.push("");

  // --- Score and rank all PRs ---
  const scoredPrs = allPrs
    .map((p) => ({ item: p, score: scoreItem(p), line: buildItemLine(p) }))
    .sort((a, b) => b.score - a.score);

  // Filter out low-impact items for the highlights
  const impactfulPrs = scoredPrs.filter((p) => p.score > 30);

  // --- Overview stats ---
  const diffAgg = aggregateDiffStats(allPrs);
  const techs = detectTechnologies(allPrs);
  const areas = new Set(allPrs.map((p) => repoToArea(p._source_repo ?? "")));

  const statParts: string[] = [];
  statParts.push(`**${allPrs.length} PRs merged**`);
  if (prReviews.length > 0) statParts.push(`**${prReviews.length} reviews**`);
  if (allIssues.length > 0) statParts.push(`**${allIssues.length} issues closed**`);
  if (totalComments > 0) statParts.push(`**${totalComments} discussions**`);

  lines.push(statParts.join(" · "));
  if (diffAgg.totalAdditions > 0 || diffAgg.totalDeletions > 0) {
    const techStr = techs.size > 0
      ? ` in ${Array.from(techs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([lang]) => lang).join(", ")}`
      : "";
    lines.push(`+${diffAgg.totalAdditions.toLocaleString()} / -${diffAgg.totalDeletions.toLocaleString()} lines across ${diffAgg.totalFiles} files${techStr}`);
  }
  if (areas.size > 1) {
    lines.push(`Spanning ${areas.size} areas: ${Array.from(areas).join(", ")}`);
  }
  lines.push("");

  // --- Key Achievements ---
  lines.push("## Key Achievements");
  lines.push("");

  if (impactfulPrs.length === 0 && allIssues.length === 0) {
    lines.push("_No notable achievements this month._");
  } else {
    // Group impactful PRs by theme
    const themeGroups = new Map<string, typeof impactfulPrs>();
    for (const pr of impactfulPrs) {
      const theme = detectItemTheme(pr.item);
      if (!themeGroups.has(theme)) themeGroups.set(theme, []);
      themeGroups.get(theme)!.push(pr);
    }

    // Sort themes by total score
    const rankedThemes = Array.from(themeGroups.entries())
      .map(([theme, prs]) => ({ theme, prs, totalScore: prs.reduce((a, p) => a + p.score, 0) }))
      .sort((a, b) => b.totalScore - a.totalScore);

    for (const { theme, prs } of rankedThemes.slice(0, 6)) {
      lines.push(`**${theme}**`);
      lines.push("");
      for (const pr of prs.slice(0, 4)) {
        lines.push(`- ${pr.line}`);
      }
      if (prs.length > 4) {
        lines.push(`- _...and ${prs.length - 4} more_`);
      }
      lines.push("");
    }

    // Show impactful issues (non-flag-graduation ones)
    const impactfulIssues = allIssues
      .filter((i) => !LOW_IMPACT_PATTERNS.some((p) => p.test(i.title ?? "")))
      .map((i) => ({ item: i, score: scoreItem(i), line: buildItemLine(i) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (impactfulIssues.length > 0) {
      const hasThemeContent = rankedThemes.length > 0;
      if (hasThemeContent) lines.push("");
      lines.push("**Issues driven to completion**");
      lines.push("");
      for (const issue of impactfulIssues) {
        lines.push(`- ${issue.line}`);
      }
    }
  }
  lines.push("");

  // --- Technical Leadership (reviews, only if substantive) ---
  if (prReviews.length > 0) {
    const uniquePRs = new Set(prReviews.map((r) => `${r._source_repo}:${r.pull_number}`));

    // Only include this section if there's meaningful review activity
    const substantiveComments = prComments
      .map((c) => cleanCommentBody(c.body ?? "", 200))
      .filter((b) => b.length > 50 && !b.match(/^\s*\W+\s*$/));

    if (uniquePRs.size >= 3 || substantiveComments.length > 0) {
      lines.push("## Technical Leadership");
      lines.push("");
      lines.push(`Reviewed ${uniquePRs.size} PRs across ${new Set(prReviews.map((r) => repoToArea(r._source_repo ?? ""))).size} areas`);

      if (substantiveComments.length > 0) {
        lines.push("");
        for (const comment of substantiveComments.slice(0, 3)) {
          lines.push(`> ${comment}`);
          lines.push("");
        }
      }
      lines.push("");
    }
  }

  // --- Compact numbers table ---
  lines.push("---");
  lines.push("");
  lines.push(`${allPrs.length} PRs · ${prReviews.length} reviews · ${allIssues.length} issues · ${totalComments} comments`);
  lines.push("");

  return lines.join("\n");
}

// Deduplicate items by title
function dedup_items(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = (item.title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Deduplicate string titles
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
  additions: number;
  deletions: number;
  filesChanged: number;
  topPrs: Array<{ title: string; line: string; score: number }>;
}

function generateSummaryMarkdown(summaries: MonthSummary[]): string {
  const lines: string[] = [];
  lines.push("# Career Achievements Summary");
  lines.push("");

  const sorted = summaries.sort((a, b) => a.month.localeCompare(b.month));
  const totalPrs = sorted.reduce((a, s) => a + s.prs, 0);
  const totalReviews = sorted.reduce((a, s) => a + s.reviews, 0);
  const totalIssues = sorted.reduce((a, s) => a + s.issues, 0);
  const totalComments = sorted.reduce((a, s) => a + s.comments, 0);
  const totalAdditions = sorted.reduce((a, s) => a + s.additions, 0);
  const totalDeletions = sorted.reduce((a, s) => a + s.deletions, 0);
  const totalFilesChanged = sorted.reduce((a, s) => a + s.filesChanged, 0);
  const firstMonth = sorted[0]?.month ?? "N/A";
  const lastMonth = sorted[sorted.length - 1]?.month ?? "N/A";

  // --- Overview ---
  lines.push(`Over **${sorted.length} months** (${monthName(firstMonth)} – ${monthName(lastMonth)}):`);
  lines.push("");
  lines.push(`- **${totalPrs} PRs merged** · ${totalReviews} code reviews · ${totalIssues} issues completed`);
  if (totalAdditions > 0) {
    lines.push(`- **+${totalAdditions.toLocaleString()} / -${totalDeletions.toLocaleString()} lines** across ${totalFilesChanged.toLocaleString()} files`);
  }
  lines.push("");

  // --- Top Achievements (all-time, ranked by impact score) ---
  lines.push("## Highest-Impact Contributions");
  lines.push("");

  const allTopPrs = sorted
    .flatMap((s) => s.topPrs.map((pr) => ({ ...pr, month: s.month })))
    .sort((a, b) => b.score - a.score);

  // Deduplicate by title key
  const seenKeys = new Set<string>();
  const uniqueTopPrs = allTopPrs.filter((pr) => {
    const key = pr.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  for (const pr of uniqueTopPrs.slice(0, 15)) {
    lines.push(`- ${pr.line} _(${monthName(pr.month)})_`);
  }
  lines.push("");

  // --- Monthly timeline ---
  lines.push("## Monthly Timeline");
  lines.push("");
  lines.push("| Month | PRs | Reviews | Issues | Lines Changed |");
  lines.push("|---|---|---|---|---|");

  for (const s of [...sorted].reverse()) {
    const linesChanged = s.additions + s.deletions > 0
      ? `+${s.additions.toLocaleString()}/-${s.deletions.toLocaleString()}`
      : "—";
    lines.push(`| [${monthName(s.month)}](${s.month}.md) | ${s.prs} | ${s.reviews} | ${s.issues} | ${linesChanged} |`);
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
      summaries.push({ month, ...nums, areas, additions: 0, deletions: 0, filesChanged: 0, topPrs: [] });
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

    const allPrs = dedup_items([...prsCreated, ...prsAssigned]);
    const allIssues = dedup_items([...issuesCreated, ...issuesAssigned]);
    const diffAgg = aggregateDiffStats(allPrs);
    const topPrs = allPrs
      .map((p) => ({ title: p.title ?? "", line: buildItemLine(p), score: scoreItem(p) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    summaries.push({
      month,
      prs: allPrs.length,
      reviews: prReviews.length,
      issues: allIssues.length,
      comments: issueComments.length + prComments.length,
      areas: buildAreaBreakdowns(allPrs, prReviews, allIssues, [...issueComments, ...prComments]),
      additions: diffAgg.totalAdditions,
      deletions: diffAgg.totalDeletions,
      filesChanged: diffAgg.totalFiles,
      topPrs,
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
        summaries.push({ month: match[1], ...nums, areas, additions: 0, deletions: 0, filesChanged: 0, topPrs: [] });
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
  // New compact format: "N PRs · N reviews · N issues · N comments"
  const compactMatch = content.match(/(\d+)\s*PRs?\s*·\s*(\d+)\s*reviews?\s*·\s*(\d+)\s*issues?\s*·\s*(\d+)\s*comments?/);
  if (compactMatch) {
    return {
      prs: parseInt(compactMatch[1], 10),
      reviews: parseInt(compactMatch[2], 10),
      issues: parseInt(compactMatch[3], 10),
      comments: parseInt(compactMatch[4], 10),
    };
  }
  // Fallback: old table format
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

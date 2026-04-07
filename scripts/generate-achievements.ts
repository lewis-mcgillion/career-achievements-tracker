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
  /\[[^\]]*\]\(\)/g,                  // empty markdown links [text]()
  /\[[^\]]*\]\(https?:\/\/[^)]*\)/g,  // markdown links with URLs
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
];

// Internal identifiers to redact
const REDACT_PATTERNS = [
  /\b[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\b/g, // org/repo
  /\b(copilot[_-]\w+)\b/gi,                 // feature flag names (keep if generic)
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

  // Clean up internal references
  for (const pat of REDACT_PATTERNS) {
    desc = desc.replace(pat, "");
  }

  // Clean up leftover artifacts
  desc = desc
    .replace(/<[^>]+>/g, "")           // any remaining HTML tags
    .replace(/\*\*[^*]*\*\*/g, "")     // bold markers with content (risk labels etc)
    .replace(/\*\*/g, "")              // orphan bold markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // remaining markdown links → text only
    .replace(/\[([^\]]*)\]\(\)/g, "$1") // empty links
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
    .replace(/\s{2,}/g, " ")
    .trim();

  if (desc.length < 15) return "";
  if (desc.length > maxLen) desc = desc.slice(0, maxLen).replace(/\s\S*$/, "…");

  return desc;
}

// Build a rich description line: title + context from body
function buildItemLine(item: ActivityItem): string {
  const title = sanitize(item.title ?? "untitled");
  const desc = extractDescription(item.body);

  if (!desc) return `**${title}**`;
  // Capitalize first letter of description
  const descCap = desc.charAt(0).toUpperCase() + desc.slice(1);
  return `**${title}** — ${descCap}`;
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
// Theme extraction — group work into meaningful categories
// ---------------------------------------------------------------------------
interface ThemeGroup {
  area: string;
  items: string[];   // rich description lines (title + body context)
  rawCount: number;   // original count before dedup
}

function extractThemes(items: ActivityItem[]): ThemeGroup[] {
  const byArea = new Map<string, string[]>();

  for (const item of items) {
    const area = repoToArea(item._source_repo ?? "");
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area)!.push(buildItemLine(item));
  }

  return Array.from(byArea.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([area, items]) => ({ area, items, rawCount: items.length }));
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
    // Detect work themes from titles to build narrative
    const allTitles = [...allPrs, ...allIssues].map((i) => (i.title ?? "").toLowerCase());
    const themeKeywords: Array<{ label: string; keywords: string[]; found: string[] }> = [
      { label: "Security", keywords: ["security", "bounty", "vulnerability", "injection", "xss", "csrf", "auth", "permission", "access control"], found: [] },
      { label: "Performance & reliability", keywords: ["performance", "optimize", "cache", "speed", "latency", "reliability", "retry", "error handling", "resilience"], found: [] },
      { label: "Accessibility", keywords: ["accessibility", "a11y", "keyboard", "screen reader", "aria", "focus", "wcag"], found: [] },
      { label: "UX improvements", keywords: ["ux", "usability", "truncat", "overflow", "responsive", "viewport", "layout", "styling", "modal", "dialog", "button"], found: [] },
      { label: "Feature development", keywords: ["implement", "add", "create", "new", "introduce", "ship", "launch", "enable"], found: [] },
      { label: "Bug fixes", keywords: ["fix", "bug", "broken", "regression", "resolve", "patch"], found: [] },
      { label: "Code quality", keywords: ["refactor", "cleanup", "remove feature flag", "graduate", "deprecat", "migrate", "tech debt"], found: [] },
      { label: "Debugging & observability", keywords: ["debug", "log", "monitor", "trace", "observ", "metric"], found: [] },
    ];

    for (const title of allTitles) {
      for (const theme of themeKeywords) {
        if (theme.keywords.some((kw) => title.includes(kw))) {
          theme.found.push(title);
        }
      }
    }

    const activeThemes = themeKeywords.filter((t) => t.found.length > 0).sort((a, b) => b.found.length - a.found.length);

    if (activeThemes.length > 0) {
      for (const theme of activeThemes.slice(0, 5)) {
        lines.push(`- **${theme.label}**: ${theme.found.length} item${theme.found.length !== 1 ? "s" : ""} across ${
          new Set([...allPrs, ...allIssues]
            .filter((i) => theme.keywords.some((kw) => (i.title ?? "").toLowerCase().includes(kw)))
            .map((i) => repoToArea(i._source_repo ?? ""))
          ).size
        } area(s)`);
      }
    }

    lines.push("");

    // Area summary with counts
    for (const theme of prThemes) {
      const issueTheme = issueThemes.find((t) => t.area === theme.area);
      const issueCount = issueTheme?.rawCount ?? 0;
      const reviewCount = prReviews.filter((r) => repoToArea(r._source_repo ?? "") === theme.area).length;
      const parts: string[] = [`${theme.rawCount} PRs shipped`];
      if (reviewCount > 0) parts.push(`${reviewCount} reviews`);
      if (issueCount > 0) parts.push(`${issueCount} issues closed`);
      lines.push(`- **${theme.area}**: ${parts.join(", ")}`);
    }
    for (const theme of issueThemes) {
      if (!prThemes.find((t) => t.area === theme.area)) {
        lines.push(`- **${theme.area}**: ${theme.rawCount} issues closed`);
      }
    }
  }
  lines.push("");

  // --- Highlights ---
  lines.push("## Highlights");
  lines.push("");
  // Pick top PRs that have the richest body descriptions (most impact detail)
  const prsWithDesc = allPrs
    .map((p) => ({ item: p, line: buildItemLine(p), descLen: extractDescription(p.body).length }))
    .filter((p) => p.descLen > 20)
    .sort((a, b) => b.descLen - a.descLen);

  const topHighlights = dedup(
    prsWithDesc.length > 0
      ? prsWithDesc.map((p) => p.line)
      : allPrs.map((p) => buildItemLine(p))
  ).slice(0, 5);

  if (topHighlights.length > 0) {
    for (const line of topHighlights) {
      lines.push(`- ${line}`);
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
      const items = dedup(theme.items).slice(0, 8);
      for (const line of items) {
        lines.push(`- ${line}`);
      }
      if (theme.rawCount > 8) {
        lines.push(`- _...and ${theme.rawCount - 8} more_`);
      }
      lines.push("");
    }
  }

  // --- Reviews & Technical Leadership ---
  lines.push("## Code Reviews & Technical Leadership");
  lines.push("");
  if (prReviews.length === 0) {
    lines.push("_No PR reviews this month._");
  } else {
    // Count unique PRs reviewed and review types
    const uniquePRs = new Set(prReviews.map((r) => `${r._source_repo}:${r.pull_number}`));
    const approvals = prReviews.filter((r) => r.state === "APPROVED").length;
    const changesRequested = prReviews.filter((r) => r.state === "CHANGES_REQUESTED").length;
    const commented = prReviews.filter((r) => r.state === "COMMENTED").length;

    lines.push(`Reviewed **${uniquePRs.size} PRs** across ${new Set(prReviews.map((r) => repoToArea(r._source_repo ?? ""))).size} area(s):`);
    lines.push("");
    const reviewParts: string[] = [];
    if (approvals > 0) reviewParts.push(`${approvals} approval${approvals !== 1 ? "s" : ""}`);
    if (changesRequested > 0) reviewParts.push(`${changesRequested} change request${changesRequested !== 1 ? "s" : ""}`);
    if (commented > 0) reviewParts.push(`${commented} review comment${commented !== 1 ? "s" : ""}`);
    lines.push(`- ${reviewParts.join(", ")}`);

    // Group by area
    const reviewByArea = new Map<string, { count: number; prs: Set<string> }>();
    for (const r of prReviews) {
      const area = repoToArea(r._source_repo ?? "");
      if (!reviewByArea.has(area)) reviewByArea.set(area, { count: 0, prs: new Set() });
      const entry = reviewByArea.get(area)!;
      entry.count++;
      entry.prs.add(`${r._source_repo}:${r.pull_number}`);
    }
    for (const [area, data] of Array.from(reviewByArea.entries()).sort((a, b) => b[1].prs.size - a[1].prs.size)) {
      lines.push(`- **${area}**: reviewed ${data.prs.size} PR${data.prs.size !== 1 ? "s" : ""}`);
    }

    // Highlight substantive review comments
    const substantiveComments = prComments
      .map((c) => cleanCommentBody(c.body ?? "", 200))
      .filter((b) => b.length > 50 && !b.match(/^\s*\W+\s*$/)); // skip emoji-only

    if (substantiveComments.length > 0) {
      lines.push("");
      lines.push("**Notable review feedback given:**");
      lines.push("");
      for (const comment of substantiveComments.slice(0, 4)) {
        lines.push(`> ${comment}`);
        lines.push("");
      }
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
      const items = dedup(theme.items).slice(0, 8);
      for (const line of items) {
        lines.push(`- ${line}`);
      }
      if (theme.rawCount > 8) {
        lines.push(`- _...and ${theme.rawCount - 8} more_`);
      }
      lines.push("");
    }
  }

  // --- Cross-team Engagement ---
  const allComments = [...issueComments, ...prComments];
  const commentAreas = new Set(allComments.map((c) => repoToArea(c._source_repo ?? "")));
  const cleanedIssueComments = issueComments
    .map((c) => cleanCommentBody(c.body ?? "", 220))
    .filter((b) => b.length > 60 && !b.match(/^\s*\W+\s*$/));

  if (cleanedIssueComments.length > 0 || commentAreas.size > 1) {
    lines.push("## Cross-team Engagement");
    lines.push("");

    if (commentAreas.size > 1) {
      lines.push(`Active across **${commentAreas.size} areas**: ${Array.from(commentAreas).join(", ")}`);
      lines.push("");
    }

    if (cleanedIssueComments.length > 0) {
      lines.push("**Key discussion contributions:**");
      lines.push("");
      for (const discussion of cleanedIssueComments.slice(0, 3)) {
        lines.push(`> ${discussion}`);
        lines.push("");
      }
    }
  }

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

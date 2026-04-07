/**
 * Cleanup script to filter existing fetched data:
 * - PRs: keep only merged PRs (pull_request.merged_at is set)
 * - Issues: keep only closed issues with state_reason "completed"
 *
 * Usage:
 *   npx tsx scripts/cleanup-data.ts --data-dir /path/to/career-data/data
 *
 * This is a one-time script to fix data fetched before the search queries
 * were updated to filter at fetch time.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

interface Args {
  dataDir: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--data-dir");
  if (idx === -1 || idx + 1 >= args.length) {
    throw new Error("Usage: npx tsx scripts/cleanup-data.ts --data-dir <path>");
  }
  return {
    dataDir: args[idx + 1],
    dryRun: args.includes("--dry-run"),
  };
}

function isMergedPR(item: Record<string, unknown>): boolean {
  const pr = item.pull_request as Record<string, unknown> | undefined;
  if (pr?.merged_at) return true;
  // Some search results use a top-level merged field
  if (item.merged_at) return true;
  return false;
}

function isCompletedIssue(item: Record<string, unknown>): boolean {
  // state_reason is set to "completed" for issues closed with resolution
  if (item.state_reason === "completed") return true;
  // If state_reason is missing (older data), keep closed issues as a fallback
  // since we can't distinguish resolved from not_planned
  if (item.state === "closed" && !item.state_reason) return true;
  return false;
}

async function processFile(
  filePath: string,
  filterFn: (item: Record<string, unknown>) => boolean,
  label: string,
  dryRun: boolean,
): Promise<{ before: number; after: number }> {
  const raw = await readFile(filePath, "utf-8");
  const items: Record<string, unknown>[] = JSON.parse(raw);

  if (!Array.isArray(items)) return { before: 0, after: 0 };

  const filtered = items.filter(filterFn);

  if (!dryRun && filtered.length !== items.length) {
    await writeFile(filePath, JSON.stringify(filtered, null, 2), "utf-8");
  }

  return { before: items.length, after: filtered.length };
}

async function main(): Promise<void> {
  const { dataDir, dryRun } = parseArgs();

  if (dryRun) console.log("🏃 DRY RUN — no files will be modified\n");

  // List month directories
  const entries = await readdir(dataDir);
  const monthDirs = entries.filter((e) => /^\d{4}-\d{2}$/.test(e)).sort();

  if (monthDirs.length === 0) {
    console.log("No month directories found.");
    return;
  }

  console.log(`Found ${monthDirs.length} month(s) to process\n`);

  const filesToClean = [
    { file: "prs-created.json", filter: isMergedPR, label: "PRs created" },
    { file: "prs-assigned.json", filter: isMergedPR, label: "PRs assigned" },
    { file: "issues-created.json", filter: isCompletedIssue, label: "Issues created" },
    { file: "issues-assigned.json", filter: isCompletedIssue, label: "Issues assigned" },
  ];

  let totalRemoved = 0;

  for (const month of monthDirs) {
    const monthPath = join(dataDir, month);
    const info = await stat(monthPath);
    if (!info.isDirectory()) continue;

    let monthChanged = false;

    for (const { file, filter, label } of filesToClean) {
      const filePath = join(monthPath, file);
      try {
        const { before, after } = await processFile(filePath, filter, label, dryRun);
        const removed = before - after;
        if (removed > 0) {
          console.log(`  ${month}/${file}: ${before} → ${after} (removed ${removed} ${label.toLowerCase()})`);
          totalRemoved += removed;
          monthChanged = true;
        }
      } catch {
        // File doesn't exist or is invalid — skip
      }
    }

    if (!monthChanged) {
      console.log(`  ${month}: no changes needed`);
    }
  }

  console.log(`\n${dryRun ? "Would remove" : "Removed"} ${totalRemoved} items total`);
  if (dryRun && totalRemoved > 0) {
    console.log("Run without --dry-run to apply changes");
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

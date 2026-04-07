import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Validation constants (exported for testing)
// ---------------------------------------------------------------------------
export const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
export const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Validation helpers (exported for testing)
// ---------------------------------------------------------------------------
export function validateUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function validateRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

export function parseRepoList(input: string): string[] {
  return input.split(",").map((r) => r.trim()).filter(Boolean);
}

export function validateRepoList(repos: string[]): { valid: boolean; invalid?: string } {
  if (repos.length === 0) return { valid: false, invalid: "(empty)" };
  for (const r of repos) {
    if (!REPO_RE.test(r)) return { valid: false, invalid: r };
  }
  return { valid: true };
}

export function validatePat(pat: string): boolean {
  return pat.length > 0;
}

export function checkRepoIsPrivate(ghOutput: string): { exists: boolean; isPrivate: boolean } {
  const exists = ghOutput.includes("career-data");
  const isPrivate = ghOutput.includes('"isPrivate":true');
  return { exists, isPrivate };
}

// ---------------------------------------------------------------------------
// Interactive readline helper
// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function run(cmd: string, silent = false): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: silent ? "pipe" : "inherit" }).trim();
  } catch {
    return "";
  }
}

function runWithEnv(cmd: string, env: Record<string, string>): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, ...env },
    }).trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Main bootstrap flow
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════╗
║      🚀 Career Achievements Tracker — Bootstrap     ║
╚══════════════════════════════════════════════════════╝
`);

  // Check prerequisites
  console.log("Checking prerequisites...\n");
  const ghVersion = run("gh --version", true);
  if (!ghVersion) {
    console.error("❌ GitHub CLI (gh) is required. Install: https://cli.github.com/");
    process.exit(1);
  }
  console.log(`✓ GitHub CLI: ${ghVersion.split("\n")[0]}`);

  const authStatus = run("gh auth status 2>&1", true);
  if (!authStatus.includes("Logged in")) {
    console.error("❌ Not authenticated with GitHub CLI. Run: gh auth login");
    process.exit(1);
  }
  console.log("✓ GitHub CLI authenticated\n");

  // Gather info
  const username = await ask("GitHub username", run("gh api user --jq .login", true));
  if (!USERNAME_RE.test(username)) {
    console.error("❌ Invalid username format.");
    process.exit(1);
  }

  const trackerRepo = await ask(
    "Tracker repo (where workflows run)",
    `${username}/career-achievements-tracker`
  );
  if (!REPO_RE.test(trackerRepo)) {
    console.error("❌ Invalid repo format. Expected: owner/repo-name");
    process.exit(1);
  }

  console.log(`\nTracker repo: ${trackerRepo}`);

  // Check tracker repo exists
  const repoCheck = run(`gh repo view ${trackerRepo} --json name 2>&1`, true);
  if (!repoCheck.includes("name")) {
    console.error(`❌ Tracker repo ${trackerRepo} not found. Create it on GitHub first.`);
    process.exit(1);
  }
  console.log(`✓ Tracker repo exists\n`);

  // Repos to track
  console.log("Enter the org/repo names you want to track (comma-separated):");
  console.log("Example: myorg/repo-one,myorg/repo-two,otherog/repo-three");
  const reposInput = await ask("Repos");
  const repos = reposInput.split(",").map((r) => r.trim()).filter(Boolean);

  if (repos.length === 0) {
    console.error("❌ At least one repo is required.");
    process.exit(1);
  }
  for (const r of repos) {
    if (!REPO_RE.test(r)) {
      console.error(`❌ Invalid repo format: "${r}". Expected: org/repo-name`);
      process.exit(1);
    }
  }
  console.log(`✓ Tracking ${repos.length} repo(s)\n`);

  // PAT
  console.log("You need a Personal Access Token (PAT) with these scopes:");
  console.log("  - repo (full access to private repos)");
  console.log("  - read:org (read org membership)");
  console.log("\nIf your repos are in an org with SSO, authorize the PAT for SSO.");
  console.log("Create one at: https://github.com/settings/tokens\n");
  const pat = await ask("Enter your PAT");

  if (!pat) {
    console.error("❌ PAT is required.");
    process.exit(1);
  }

  // Validate PAT using environment variable (not command-line arg)
  console.log("\nValidating PAT...");
  const patUser = runWithEnv("gh api user --jq .login", { GH_TOKEN: pat });
  if (!patUser) {
    console.error("❌ PAT validation failed. Check the token and try again.");
    process.exit(1);
  }
  if (patUser !== username) {
    console.warn(`⚠ PAT authenticated as "${patUser}" (expected "${username}")`);
  } else {
    console.log("✓ PAT valid");
  }

  // Create private career-data repo
  console.log("\n--- Creating private career-data repo ---\n");
  const careerDataRepo = `${username}/career-data`;
  const existingRepo = run(`gh repo view ${careerDataRepo} --json name,isPrivate 2>&1`, true);
  if (existingRepo.includes("career-data")) {
    // Verify it's private
    if (!existingRepo.includes('"isPrivate":true')) {
      console.error("❌ career-data repo exists but is NOT private! Make it private before continuing.");
      console.error("   Go to: https://github.com/" + careerDataRepo + "/settings");
      process.exit(1);
    }
    console.log("✓ career-data repo exists and is private");
  } else {
    run(`gh repo create ${careerDataRepo} --private --description "Private raw data store for career achievements tracker" --clone=false`);
    console.log("✓ Created private career-data repo");

    // Initialize with README
    run(`gh api repos/${careerDataRepo}/contents/README.md -X PUT -f message="Initial commit" -f content="$(echo '# Career Data (Private)\n\nPrivate raw data for the Career Achievements Tracker.' | base64)" 2>&1`, true);
  }

  // Set secrets on the profile repo using stdin (not command-line args, not bash -c)
  console.log("\n--- Configuring GitHub Actions secrets ---\n");

  execSync(`gh secret set CAREER_DATA_PAT --repo ${trackerRepo}`, {
    input: pat,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GH_TOKEN: pat },
  });
  console.log("✓ Set CAREER_DATA_PAT secret");

  const reposCsv = repos.join(",");
  execSync(`gh secret set TRACKED_REPOS --repo ${trackerRepo}`, {
    input: reposCsv,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GH_TOKEN: pat },
  });
  console.log(`✓ Set TRACKED_REPOS (${repos.length} repos configured)`);

  // Create copilot label if not exists
  console.log("\n--- Ensuring 'copilot' label exists ---\n");
  run(`gh label create copilot --repo ${trackerRepo} --description "Copilot coding agent tasks" --color 8957e5 --force`);
  console.log("✓ 'copilot' label ready");

  // Summary
  console.log(`
╔══════════════════════════════════════════════════════╗
║                   ✅ Setup Complete!                  ║
╚══════════════════════════════════════════════════════╝

  Tracker repo:  ${trackerRepo}
  Data repo:     ${careerDataRepo} (private)
  Tracking:      ${repos.length} repo(s)
  Cron:          1st of every month at midnight UTC

  Next steps:
  1. Make sure the workflow files and scripts are in your tracker repo
  2. Run the backfill:
     gh workflow run fetch-activity.yml \\
       --repo ${trackerRepo} \\
       -f start_date=2025-01-01 \\
       -f end_date=$(date '+%Y-%m-%d')
  3. After fetch completes, trigger the summary:
     gh workflow run generate-summary.yml \\
       --repo ${trackerRepo} \\
       -f months="2025-01,2025-02,..."
`);

  rl.close();
}

main().catch(() => {
  console.error("Setup failed. Please check the errors above and try again.");
  rl.close();
  process.exit(1);
});

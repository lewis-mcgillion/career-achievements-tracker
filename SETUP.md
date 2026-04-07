# Setting Up the Career Achievements Tracker

A step-by-step guide to set up your own automated career achievements tracker. This system fetches your GitHub activity monthly and uses a Copilot coding agent to generate polished achievement summaries — perfect for performance reviews.

## How it works

```
career-achievements-tracker repo                [PUBLIC]
├── .github/workflows/ (fetch + summarize)
├── .github/copilot-instructions.md
├── scripts/fetch-activity.ts
├── package.json
└── Secrets (repo names, PAT)
         │
         │ fetches data, triggers agent
         ▼
career-data repo (<username>/career-data)       [PRIVATE]
├── data/YYYY-MM/*.json (raw GitHub API data)
└── achievements/*.md (monthly summaries)
```

Everything sensitive — raw data AND achievement summaries — lives in the private repo. The public repo only contains the reusable infrastructure.

## Prerequisites

- A GitHub account with a repository to host the tracker (e.g., fork this repo or create your own)
- Access to the [Copilot coding agent](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent) on that repo
- Read access to the org repositories you want to track
- [GitHub CLI](https://cli.github.com/) installed locally
- [Node.js](https://nodejs.org/) v22+ installed locally

## Quick Setup (Automated)

The fastest way to get started is with the bootstrap script:

```bash
# 1. Fork or clone this repo
# Fork via GitHub UI, or:
gh repo fork lewis-mcgillion/career-achievements-tracker --clone

# 2. Install dependencies
cd career-achievements-tracker && npm install

# 3. Run the bootstrap script
npx tsx scripts/bootstrap.ts
```

The bootstrap script will interactively:
- ✅ Create a private `career-data` repo for raw data and summaries
- ✅ Verify the private repo is actually private
- ✅ Configure all required GitHub Actions secrets
- ✅ Set up the `copilot` label for the agent

## Manual Setup

If you prefer to set things up manually, follow these steps:

### 1. Copy Files to Your Profile Repo

Copy these files/directories to your repo (or fork this repo directly):

```
.github/
├── copilot-instructions.md
├── copilot-setup-steps.yml
└── workflows/
    ├── fetch-activity.yml
    └── generate-summary.yml
scripts/
├── fetch-activity.ts
└── bootstrap.ts
package.json
tsconfig.json
```

### 2. Create a Personal Access Token (PAT)

Go to [GitHub Settings → Tokens](https://github.com/settings/tokens) and create a **fine-grained** or **classic** PAT with these scopes:

| Scope | Purpose |
|-------|---------|
| `repo` | Full access to push to your private career-data repo |
| `read:org` | Read org membership to access org repos |

> **⚠️ SSO Note:** If the repos you're tracking are in an organization with SAML SSO, you must [authorize the PAT for SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on).

### 3. Create the Private Data Repo

```bash
gh repo create <your-username>/career-data \
  --private \
  --description "Private raw data store for career achievements tracker"
```

### 4. Configure GitHub Actions Secrets

Set these secrets on your **tracker repo** (`<username>/career-achievements-tracker`):

```bash
# The PAT you created in step 2
gh secret set CAREER_DATA_PAT --repo <username>/career-achievements-tracker

# All repos to track (comma-separated, single secret)
echo "org/repo-1,org/repo-2,org/repo-3" | gh secret set TRACKED_REPOS --repo <username>/career-achievements-tracker
```

### 5. Create the Copilot Label

```bash
gh label create copilot \
  --repo <username>/career-achievements-tracker \
  --description "Copilot coding agent tasks" \
  --color 8957e5 \
  --force
```

### 6. Install Dependencies and Push

```bash
cd <your-tracker-repo>
npm install
git add -A
git commit -m "Add career achievements tracker"
git push
```

## Usage

### Monthly Cron (Automatic)

The `fetch-activity` workflow runs automatically at midnight UTC on the 1st of every month. After fetching data, it triggers the `generate-summary` workflow which creates a GitHub issue for the Copilot agent to generate that month's achievement summary.

**No action needed** — it just works!

### Initial Backfill

To fetch historical data back to a specific date:

```bash
gh workflow run fetch-activity.yml \
  --repo <username>/career-achievements-tracker \
  -f start_date=2025-01-01 \
  -f end_date=$(date '+%Y-%m-%d')
```

Then trigger the summary generation for all months:

```bash
gh workflow run generate-summary.yml \
  --repo <username>/career-achievements-tracker \
  -f months="2025-01,2025-02,2025-03"
```

### Re-generate a Specific Month

```bash
gh workflow run generate-summary.yml \
  --repo <username>/career-achievements-tracker \
  -f months="2025-06"
```

## Customization

### Adding or Removing Tracked Repos

Update the `TRACKED_REPOS` secret (comma-separated list):

```bash
echo "org/repo-1,org/repo-2,org/new-repo" | gh secret set TRACKED_REPOS --repo <username>/career-achievements-tracker
```

### Changing the Cron Schedule

Edit `.github/workflows/fetch-activity.yml` and update the cron expression:

```yaml
schedule:
  - cron: "0 0 1 * *"  # Current: 1st of month at midnight UTC
  # Examples:
  # "0 0 * * 1"   — Every Monday
  # "0 0 1,15 * *" — 1st and 15th of month
```

### Customizing the Summary Format

Edit `.github/copilot-instructions.md` to change:
- The structure of monthly achievement files
- Sanitization rules (what to redact/generalize)
- Tone and language preferences
- What data to emphasize or de-emphasize

Edit `achievements/TEMPLATE.md` in your private career-data repo to change the template structure.

## Troubleshooting

### "Resource not accessible by integration"
Your PAT doesn't have sufficient permissions. Ensure it has `repo` and `read:org` scopes, and is SSO-authorized if needed.

### "Not Found" errors when fetching data
The PAT may not have access to the org repos. Check SSO authorization and org membership.

### Rate limiting
The fetch script handles rate limits automatically by waiting and retrying. For large backfills across many repos, it may take some time. GitHub allows 5,000 requests/hour for authenticated users.

### Copilot agent not responding
Ensure the `copilot` label exists on your profile repo and that Copilot coding agent is enabled in your repo settings.

### No data for a month
Check the private `career-data` repo to see if the JSON files were populated. If they're empty, verify you have activity in the tracked repos for that period.

## Security

- **Everything sensitive is private** — raw data AND achievement summaries live in the private `career-data` repo
- **The public repo is just infrastructure** — workflows, scripts, and setup docs. No data.
- **Repo names** are stored as GitHub Actions secrets, never in code or logs
- **PATs** are passed via environment variables, never as command-line arguments
- **Error messages** are sanitized to strip URLs and repo names before logging
- **The Copilot agent** writes only to the private repo, never the public one

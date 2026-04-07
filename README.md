# Career Achievements Tracker

An automated system that tracks your GitHub contributions across multiple repositories and generates monthly achievement summaries — useful for performance reviews, self-reflection, and career growth.

## What it does

1. **Fetches your GitHub activity** — issues, PRs, reviews, and comments across the repos you choose
2. **Stores raw data privately** — all JSON data goes to a separate private repo
3. **Generates achievement summaries** — a Copilot coding agent reads the raw data and writes polished, sanitized monthly markdown summaries
4. **Runs monthly on autopilot** — GitHub Actions cron job handles everything

The summaries focus on impact and themes, not raw activity. Internal repo names, issue numbers, and other sensitive details are stripped out so the summaries are safe to share.

## Quick start

See [SETUP.md](SETUP.md) for the full setup guide, or run:

```bash
gh repo fork lewis-mcgillion/career-achievements-tracker --clone
cd career-achievements-tracker
npm install
npx tsx scripts/bootstrap.ts
```

The bootstrap script walks you through everything interactively.

## Architecture

```
This repo (public)                              Private career-data repo
├── .github/workflows/     ──fetch──►           ├── data/YYYY-MM/*.json
├── scripts/                                    └── achievements/*.md
└── package.json            ──agent──►              (monthly summaries)
```

All sensitive data lives in your private `career-data` repo. This repo is just the engine.

## Requirements

- GitHub account with [Copilot coding agent](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent) access
- Read access to the repos you want to track
- A PAT with `repo` + `read:org` scopes

## License

MIT

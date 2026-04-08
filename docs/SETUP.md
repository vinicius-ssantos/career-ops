# Setup Guide

## Prerequisites

- Node.js 18+ (for PDF generation and utility scripts)
- (Optional) Go 1.21+ (for the dashboard TUI)
- One supported agent surface:
  - Codex (`AGENTS.md`)
  - [Claude Code](https://claude.ai/code) (`CLAUDE.md`)
  - OpenCode (`.opencode/commands/`)

## Quick Start (5 steps)

### 1. Clone and install

```bash
git clone https://github.com/santifer/career-ops.git
cd career-ops
npm install
npx playwright install chromium   # Required for PDF generation
```

### 2. Configure your profile

```bash
cp config/profile.example.yml config/profile.yml
```

Edit `config/profile.yml` with your personal details: name, email, target roles, narrative, proof points.

### 3. Add your CV

Create `cv.md` in the project root with your full CV in markdown format. This is the source of truth for all evaluations and PDFs.

(Optional) Create `article-digest.md` with proof points from your portfolio projects/articles.

### 4. Configure portals

```bash
cp templates/portals.example.yml portals.yml
```

Edit `portals.yml`:
- Update `title_filter.positive` with keywords matching your target roles
- Add companies you want to track in `tracked_companies`
- Customize `search_queries` for your preferred job boards

### 5. Start using

Open your preferred agent in this directory:

```bash
# Examples:
# codex
# claude
```

Then paste a job offer URL or description. Career-ops will evaluate it, generate a report, create a tailored PDF, and track it. For Codex, the repository-native entrypoint is `AGENTS.md`.

## Recommended Discovery Flow

In practice, the most reliable workflow is:

1. Discover jobs on LinkedIn or another broad job board.
2. Feed the interesting role into career-ops by URL or by saving the JD locally.
3. Use career-ops for fit evaluation, CV tailoring, tracker updates, and application prep.

If a LinkedIn URL is accessible directly:

```bash
npm run extract:jd -- "<job-url>" --out "jds/company-role.md"
```

If LinkedIn requires login or the page does not extract cleanly:

1. Save the job description manually to `jds/company-role.md`
2. Add it to `data/pipeline.md` as `local:jds/company-role.md | Company | Role`

Treat `/career-ops scan` as a secondary source of discovery, not the primary one.

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | LinkedIn first, `/career-ops scan` second |
| Process pending URLs | `/career-ops pipeline` |
| Generate a PDF | `/career-ops pdf` |
| Batch evaluate | `/career-ops batch` |
| Check tracker status | `/career-ops tracker` |
| Fill application form | `/career-ops apply` |

Repository-native helpers:

```bash
npm run extract:jd -- <job-url>
npm run scan:portals
```

## Verify Setup

```bash
node cv-sync-check.mjs      # Check configuration
node verify-pipeline.mjs     # Check pipeline integrity
```

## Build Dashboard (Optional)

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..  # Opens TUI pipeline viewer
```

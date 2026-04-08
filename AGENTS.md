# Career-Ops Agent Guide

## Purpose

Career-ops is a local, agent-assisted job search system. The repository is the product. The agent is an interface over:

- `modes/*.md` for workflow logic
- `config/profile.yml`, `cv.md`, `modes/_profile.md` for user-specific context
- `*.mjs` scripts for extraction, PDF generation, integrity, and scanning
- `data/*`, `reports/*`, `output/*` for user artifacts

## Source of Truth

Read [DATA_CONTRACT.md](DATA_CONTRACT.md) before making changes.

- User layer: never overwrite during system changes
- System layer: safe to evolve when improving the product

When the user asks to personalize the system, write to the user layer, not the system layer.

## Preferred Operating Model

For Codex and other coding agents:

1. Use local scripts first when the repository already provides them.
2. Treat agent-native browser/web tools as optional accelerators, not hard dependencies.
3. Keep formats stable:
   - `data/applications.md`
   - `data/pipeline.md`
   - `data/scan-history.tsv`
   - `reports/*.md`
   - `output/*.pdf`
4. Preserve compatibility with Claude Code and OpenCode integrations unless the user explicitly wants to drop them.

## Core Files

| File | Role |
|------|------|
| `modes/_shared.md` | Global scoring rules and workflow conventions |
| `modes/*.md` | Mode-specific instructions |
| `config/profile.yml` | Candidate profile |
| `modes/_profile.md` | User-specific framing and customization |
| `extract-jd.mjs` | Local extraction of job descriptions from URLs |
| `scan-portals.mjs` | Local portal scan for tracked companies |
| `generate-pdf.mjs` | HTML to PDF generator |
| `merge-tracker.mjs` | Merges batch additions into tracker |
| `verify-pipeline.mjs` | Pipeline health checks |

## Mode Mapping

The product modes remain the same across platforms:

- `auto-pipeline`
- `oferta`
- `ofertas`
- `pdf`
- `contacto`
- `apply`
- `pipeline`
- `scan`
- `batch`
- `tracker`
- `deep`
- `training`
- `project`

If a platform provides slash commands or skills, route into these modes. Do not fork business logic per platform unless a platform capability gap forces it.

## Platform Support Defaults

- Claude Code: full support, including existing integrations
- OpenCode: supported through `.opencode/commands`
- Codex: officially supported for repository-native workflows

Current Codex defaults:

- Supported: evaluation, PDF, tracker, deep research prompts, project/training evaluation, pipeline processing via local extraction, and tracked-company scanning via local script
- Limited: live application browser automation
- Not yet parity-complete: headless parallel batch execution equivalent to `claude -p`

## Operational Rules

### Setup and health

- Use `npm run doctor` to validate setup
- Use `npm run verify` to validate tracker integrity

### Extraction

- Prefer `node extract-jd.mjs <url>` for URL ingestion when browser extraction is needed
- Use `node check-liveness.mjs <url>` when only liveness must be verified

### Scanning

- Prefer `node scan-portals.mjs` for tracked-company scanning
- Keep `portals.yml` as the scanner configuration source of truth

### Tracking

- Never append new rows directly to `data/applications.md` if the workflow expects tracker additions via merge scripts
- Keep canonical statuses aligned with `templates/states.yml`

## Backward Compatibility

- Do not remove `CLAUDE.md` or `.opencode/commands/*` unless explicitly requested
- When updating docs, present the repo as multi-platform and describe capability differences honestly

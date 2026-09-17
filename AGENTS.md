# AGENTS.md

## Docs gate

`docs/prd/` is the frozen PRD. After editing anything under it, run `pnpm check:docs` — a static gate (registry `docs/prd/spec/check-registry.json` + `scripts/check-docs.mjs`) that asserts the check-item IDs, the ticket index, the referenced files/sections and the stated counts all stay consistent. See `docs/prd/spec/08-本地开发指南.md` §3.3. Rewrite the ticket index column from the ticket headers with `pnpm check:docs -- --write-index`.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/` (local markdown; this repo has no git remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, labels equal to their role names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

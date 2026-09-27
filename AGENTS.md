# AGENTS.md

This repository is a **GitHub-native contract pack** for coding agents.
It is not a forge, not a VCS, and not an orchestrator.

## What this repo is

Reusable conventions and small tools so Copilot, GitHub Agentic Workflows (`gh-aw`), Hermes, Codex, and other agents can share:

- repository instructions (`AGENTS.md`)
- portable skills (`SKILL.md`)
- GitHub App bot identity for commits
- commit trailers for agent provenance
- a scoped GitHub MCP allowlist
- safe-output agentic workflows that run on GitHub Actions

## Hard boundaries

- Work only in this repository.
- Do not modify files outside this repo.
- Do not invent a new git server, object store, or identity protocol.
- Do not put personal access tokens, Copilot tokens, or App private keys in the repo.
- Do not grant agents `admin`, `delete`, or unscoped `repo` power in examples.
- Default writes on GitHub are **safe outputs only**: comments, labels, draft PRs — never force-push, never merge without a human.

## Day-1 build targets

Implement what `docs/DAY1_SCOPE.md` lists. Prefer small, tested files.

## Commands

```bash
# Trailer checker (Node, no deps)
node scripts/check-agent-trailers.mjs --help
node scripts/check-agent-trailers.mjs --message-file path/to/msg.txt

# Tests
node --test tests/*.test.mjs
```

If `gh` and the `gh-aw` extension are installed:

```bash
gh aw compile
```

If they are not installed, leave compiled `.lock.yml` files out and keep Markdown sources under `.github/workflows-src/`.

## Code style

- JavaScript: ESM (`.mjs`), Node 20+, no runtime dependencies for scripts.
- Actions: `actions/checkout@v4` and `actions/github-script@v7` only unless a comment explains why.
- Markdown: short headings, copy-pasteable YAML, no vendor marketing.

## PR rules

- One concern per PR.
- Title: `[area] imperative summary` (example: `[scripts] reject missing AI-Agent trailer`).
- Include tests when you change `scripts/` or the Action.
- Never commit secrets or `.env`.

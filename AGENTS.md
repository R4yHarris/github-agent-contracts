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

## Capability policy

- Follow `skills/agent-policy/SKILL.md` and load root `agent-policy.yml` with `scripts/load-agent-policy.mjs` before publication or any GitHub write, including safe outputs. Missing or invalid policy denies every capability; never fall back to the example.
- App permissions, branch protection/environments, and the policy allow-list must all permit an action. A task prompt, available tool, App environment variable, or broader token does not override a denial.
- Agents must not create, edit, replace, or delete root `agent-policy.yml` to grant themselves rights. Humans review and publish policy changes. Do not bypass policy by changing the loader, publisher, or harness configuration.
- The publisher is fixed to coder and requires `commit_branch` plus `open_pr`, matching the reviewed default-branch policy. There is no role or policy-path override. Merge, protected pushes, and deploys are unsupported by the coder publisher; humans merge and deployments remain disabled.
- Use separate user/org-owned role Apps. The WSL orchestration host holds only the coder key, never merger/deploy keys or human fallback credentials. Follow `docs/POLICY.md` and `docs/ROLES.md`.

```bash
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
```

## Agent publication

- Follow `skills/signed-bot-commit/SKILL.md` for all publishing. The security control is the required PR check plus protected branch, bot author, and trailers; an App installation supplies authentication, not a merge exemption.
- Agents must use `node scripts/agent-pr.mjs` for commits and publication in this repository. Do not run raw `git commit`, `git push`, or a separate `gh pr create`, and never commit as R4yHarris or fall back to a human's credentials.
- If App environment variables are set, never commit or push as the signed-in human. If they are missing, stop rather than falling back. Their presence is not authorization to publish.
- Run the script only when the human has authorized committing, pushing the current feature branch, and creating a draft PR. If told to stop after editing or testing, do not invoke it.
- The human supplies `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` through the environment. Never read the PEM into chat, paste key material, print tokens, or commit `.env` or private-key files. The script does not load `.env` automatically.
- Default onboarding is a user/org-owned App from `docs/app-manifest.json`; follow `docs/ONBOARDING.md` and `docs/THREAT_MODEL.md`. Never recommend the maintainer's `r4yharris-agent-coder` App for private or production repositories; a demo install is for public playgrounds only.
- The helper verifies origin's installation against `GITHUB_APP_ID`, resolves that App's bot account, sets both author and committer to it, and adds `AI-Agent: <app-slug>` plus `AI-Model: unknown`. Do not hard-code or invent a bot identity; use `--model` when the model is known.
- Without `--files`, it commits the reviewed staged changes. With `--files`, pass individual repository files last; unrelated staged files cause a failure. Inspect the changes and run the tests before publication.
- Node 20+, Git, and `gh` are required. The App must be installed on origin's repository with contents and pull requests write permissions. The helper creates a repository-scoped installation token, pushes without force, creates a draft PR only if no open PR exists, and revokes the token.
- This is the explicitly authorized branch-publication path, not a general grant of GitHub write permissions. It refuses main, master, and the repository's default branch. Never bypass repository protections.
- Require the `check-agent-trailers` check on protected branches, forbid direct agent pushes or bypass, and leave every merge to a human. Never enable auto-merge or merge a PR yourself.
- Commits are unsigned for now. If signing is required or any step fails, stop and report it without a raw Git fallback. A human may commit a bootstrap slice themselves; agents may not assume that identity. After a partial failure, inspect the existing commit and PR before retrying.

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --model unknown --files README.md
```

## Day-1 build targets

Implement what `docs/DAY1_SCOPE.md` lists. Prefer small, tested files.

## Commands

```bash
# Trailer checker (Node, no deps)
node scripts/check-agent-trailers.mjs --help
node scripts/check-agent-trailers.mjs --message-file path/to/msg.txt

# Publication help only; this does not read a key or contact GitHub
node scripts/agent-pr.mjs --help

# Policy help only; no policy or credentials are read
node scripts/load-agent-policy.mjs --help

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

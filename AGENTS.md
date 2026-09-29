# AGENTS.md

This repository defines the **GitHub identity and permissions contract for coding agents**: a user-owned GitHub App bot, a human-owned default-deny capability policy, and machine-checked provenance trailers separate agent contributions from human authors.

Hermes, Claude Code, GitHub Copilot, OpenClaw, Cursor, Codex, and other harnesses **MUST NOT run git commit or git push as the signed-in human when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` are set**. Load `skills/agent-policy/SKILL.md` and `skills/signed-bot-commit/SKILL.md`; use `node scripts/agent-pr.mjs` for explicitly authorized publication. Missing App configuration means leave changes uncommitted, never use a human credential fallback.

Humans own `agent-policy.yml` and workflow changes. Default merge is human-only; `--merge-when-green` additionally requires human authorization and `merger.merge` in local and reviewed policy. Never self-grant, self-approve, force-push, or deploy.

This is a GitHub-native contract pack, not a forge, VCS, or orchestrator. Start with [onboarding](docs/ONBOARDING.md) and [the threat model](docs/THREAT_MODEL.md).

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
- Default writes on GitHub are **safe outputs only**: comments, labels, draft PRs. Never force-push. Merging requires explicit human authorization, a human-reviewed policy grant, and the opt-in flow below.

## Capability policy

- Follow `skills/agent-policy/SKILL.md` and load root `agent-policy.yml` with `scripts/load-agent-policy.mjs` before publication or any GitHub write, including safe outputs. Missing or invalid policy denies every capability; never fall back to the example.
- App permissions, branch protection/environments, and the policy allow-list must all permit an action. A task prompt, available tool, App environment variable, or broader token does not override a denial.
- Agents must not create, edit, replace, or delete root `agent-policy.yml` to grant themselves rights. Humans review and publish policy changes. Do not bypass policy by changing the loader, publisher, or harness configuration.
- The publisher requires coder `commit_branch` plus `open_pr`, matching the reviewed default-branch policy. There is no role or policy-path override. `--merge-when-green` additionally requires `merger.merge` in both local and reviewed default-branch policy; coder `merge` alone is insufficient. Human-only merge remains the default. A policy role is not proof of which App key is loaded: the helper uses the two supplied App environment variables and does not switch keys. Protected pushes and deploys remain unsupported.
- Use separate user/org-owned role Apps. The WSL orchestration host holds only the coder key, never merger/deploy keys or human fallback credentials. Follow `docs/POLICY.md` and `docs/ROLES.md`.

```bash
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
```

## Agent publication

- Follow `skills/signed-bot-commit/SKILL.md` for all publishing. The security control is the required PR check plus protected branch, bot author, and trailers; an App installation supplies authentication, not a merge exemption.
- Agents must use `node scripts/agent-pr.mjs` for commits and publication in this repository. Do not run raw `git commit`, `git push`, or a separate `gh pr create`, and never commit as R4yHarris or fall back to a human's credentials.
- If App environment variables are set, never commit or push as the signed-in human. If they are missing, finish after tests and leave changes uncommitted; never fall back to a human token. Their presence is not authorization to publish.
- After reviewing the files, staging or selecting only intended files, passing tests and policy gates, run the script as the final step only when the human has authorized committing, pushing the current feature branch, and creating a draft PR. If told to stop after editing or testing, do not invoke it.
- Only use `--merge-when-green` when the human also authorizes merging and remote feature-branch deletion. A human must first add `merge` to `roles.merger.allow` in root `agent-policy.yml` and publish that grant on the default branch. Never edit the policy yourself or treat the flag as a grant. Keep the flag disabled on coder-only WSL; a trusted launcher/operator must use a separately approved merger App/context for merging.
- The human supplies `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` through the environment. Never read the PEM into chat, paste key material, print tokens, or commit `.env` or private-key files. The script does not load `.env` automatically.
- Default onboarding is a user/org-owned App from `docs/app-manifest.json`; follow `docs/ONBOARDING.md` and `docs/THREAT_MODEL.md`. Never recommend the maintainer's `r4yharris-agent-coder` App for private or production repositories; a demo install is for public playgrounds only.
- The helper verifies origin's installation against `GITHUB_APP_ID`, resolves that App's bot account, sets both author and committer to it, and adds `AI-Agent: <app-slug>` plus the actual `AI-Model` id from `--model` or `AI_MODEL`. Neither has an `unknown` fallback; if the model is unavailable, stop without publishing. Do not hard-code or invent a bot identity or model.
- Without `--files`, it commits the reviewed staged changes. With `--files`, pass individual repository files last; unrelated staged files cause a failure. Staged or selected `.github/workflows/**` paths are refused before token minting; a human must publish workflow changes. Inspect the changes and run the tests before publication.
- Node 20+, Git, and `gh` are required. The App must be installed on origin's repository with contents and pull requests write permissions; the opt-in merge flow also needs Checks read permission. The helper creates a repository-scoped installation token, pushes without force, creates a draft PR only if no open PR exists, and revokes the token.
- This is the explicitly authorized branch-publication path, not a general grant of GitHub write permissions. It refuses main, master, and the repository's default branch. Never bypass repository protections.
- Require the `check-agent-trailers` check on protected branches and forbid direct agent pushes or bypass. By default, leave merges to humans. The sole script-managed exception is authorized `--merge-when-green`: require a successful GitHub Actions check on the exact head SHA and all repository merge requirements, then create a merge commit and delete only the unchanged remote feature branch. After confirmed merge, fetch origin with App auth, check out and fast-forward the default branch, and delete the local feature ref only if the worktree is clean and that ref still points to the published head included in the merge. Dirty or moved state aborts local cleanup without discarding work; report partial cleanup.
- Never self-approve, squash, rebase-merge, force-push, push main, or enable GitHub auto-merge. Marking an authorized draft ready does not approve it or bypass required human reviews. See `docs/POLICY.md` for polling, permission, and failure details.
- Commits are unsigned for now. If signing is required or any step fails, stop and report it without a raw Git fallback. A human may commit a bootstrap slice themselves; agents may not assume that identity. After a partial failure, inspect the existing commit and PR before retrying.

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --model gpt-5 --files README.md
```

## Optional run metadata

- Harnesses SHOULD export the known `AI_PROVIDER`, `AI_MODEL`, `AI_MODEL_VERSION`, `AI_EFFORT`, `AI_CONTEXT_USED`, `AI_CONTEXT_MAX`, `AI_CONTEXT_OUT`, `AI_SESSION`, and `AI_TASK` values before invoking `agent-pr.mjs`. Never invent missing values or infer counts, effort, session, or task identifiers.
- Follow `docs/METRICS.md`: the helper emits a single optional compact `AI-Run` trailer and tagged PR body pair when metadata is supplied. `--model` overrides `AI_MODEL`; absent environment metadata leaves the two required trailers unchanged. No prompts, traces, credentials, extra `AI-X-*` trailers, or second YAML document belong in git.
- Humans evaluate through separate `AI-Eval` PR comments, not by editing trailers. Agents must not generate evaluations, quality scores, or analytics-service integrations.

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

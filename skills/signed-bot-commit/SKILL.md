---
name: signed-bot-commit
description: Use when an agent is authorized to commit, push a feature branch, or create a draft PR. Require scripts/agent-pr.mjs for GitHub App bot identity and provenance; never use raw git commit or push.
---

# Signed bot commit

## Onboarding

Use `docs/ONBOARDING.md` and `docs/app-manifest.json` to register an App owned by the consuming user or organization. Keep it private to that account and install it on selected repositories. The static manifest is not a hosted registration service; callback hosting is a follow-on controlled by the App owner.

Never recommend the maintainer's `r4yharris-agent-coder` App for private or production repositories. It is an optional public-playground demo only. Whoever holds an App's private key can mint tokens for all of its installations; review `docs/THREAT_MODEL.md` before enabling access.

## Do

1. Read `AGENTS.md` and confirm the human authorized **commit, push, and draft PR creation**. A request to stop after editing or testing prohibits running the helper.
2. Use only `node scripts/agent-pr.mjs` from the repository root. Do not run raw `git commit`, `git push`, or a separate `gh pr create`; do not fall back to a human identity or credentials.
3. Confirm Node 20+, Git, and `gh` are available. The human supplies `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` through the environment; CI uses the `GITHUB_APP_PRIVATE_KEY` secret through an approved temporary-file bootstrap. Never read the PEM into chat, display tokens, or commit `.env` or private-key files. The helper does not load `.env` automatically. Missing App configuration means stop, not use the signed-in human.
4. Review the staged changes, or select individual repository files with `--files`. Do not pass directories. The helper refuses unrelated staged files when explicit files are selected. Run `node --test tests/*.test.mjs` before publishing.
5. Keep the current branch a feature branch. The helper uses only origin's repository, refuses default-branch publication, and never force-pushes or merges. Require `check-agent-trailers` and human approval on protected branches, grant the App no bypass, and leave merging to humans.

## Identity and trailers

The helper verifies that origin's active installation matches `GITHUB_APP_ID`, then resolves `<app-slug>[bot]` from GitHub and verifies its login, bot type, and numeric user ID. Both author and committer use that account and `BOT_USER_ID+<app-slug>[bot]@users.noreply.github.com`. The bot user ID is not the App ID. No hard-coded maintainer identity or extra identity environment variables are needed.

Pass a commit message without inventing credentials or manually changing Git's global configuration. The helper appends:

```text
AI-Agent: <your-app-slug>
AI-Model: unknown
```

Use `--model` to replace `unknown` when the actual model is known. It checks the committed author, committer, trailers, and protected file paths before pushing the verified commit.

## Usage

With reviewed changes already staged:

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --model unknown
```

To stage and commit named files, put `--files` last:

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --files README.md AGENTS.md
```

`--help` does not read the key or contact GitHub. Normal invocation signs an App JWT, discovers the repository installation, and requests an installation token scoped to that repository with contents and pull requests write permissions. It makes an unsigned bot commit, pushes with in-memory authentication, reuses an open PR for the branch or runs `gh pr create --draft`, then revokes the token. New PR titles follow the repository's `[area] summary` convention with `[agent]` as the default area.

## Failure handling

If authentication, signing policy, staging, commit, push, or PR creation fails, stop. Do not use raw Git or a human token to work around the failure. A push or PR error can leave the local commit in place; inspect the branch and existing PR before any retry so the same work is not committed twice. Ask the human to handle a partial publication when needed. The script withholds child-process output to avoid exposing secrets.

Despite this skill's name, the current helper creates **unsigned Git commits**. Its signed JWT authenticates the App, not the Git commit. Do not invoke it in a repository requiring signed commits until the helper supports that policy; never claim that bot fields or trailers alone produce a Verified signature.

## Do not

- Commit as R4yHarris or another human, including during bootstrap. A human can commit a bootstrap slice themselves.
- Force-push any branch or merge a PR.
- Amend someone else's commit.
- Write tokens, App private keys, or signing keys into the repository.
- Bypass a repository's signing or human-approval requirement.

---
name: signed-bot-commit
description: Use when an agent is authorized to publish a feature branch or explicitly merge when green. Require scripts/agent-pr.mjs for App bot identity, provenance, and policy-gated merging; never use raw git commit or push.
---

# Signed bot commit

## Onboarding

Use `docs/ONBOARDING.md` and `docs/app-manifest.json` to register an App owned by the consuming user or organization. Keep it private to that account and install it on selected repositories. The static manifest is not a hosted registration service; callback hosting is a follow-on controlled by the App owner.

Never recommend the maintainer's `r4yharris-agent-coder` App for private or production repositories. It is an optional public-playground demo only. Whoever holds an App's private key can mint tokens for all of its installations; review `docs/THREAT_MODEL.md` before enabling access.

## Do

1. Read `AGENTS.md`, load the root policy through `scripts/load-agent-policy.mjs`, and follow `skills/agent-policy/SKILL.md`. Require coder `commit_branch` and `open_pr`, then confirm the human authorized **commit, push, and draft PR creation**. The optional merge flag also requires `merger.merge` in local and reviewed default-branch policy and human authorization for merge and branch cleanup; coder `merge` alone is insufficient. Missing or denied policy means stop. A request to stop after editing or testing prohibits running the helper.
2. Use only `node scripts/agent-pr.mjs` from the repository root. Do not run raw `git commit`, `git push`, or a separate `gh pr create`; do not fall back to a human identity or credentials.
3. Confirm Node 20+, Git, and `gh` are available. The human supplies `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` through the environment; CI uses the `GITHUB_APP_PRIVATE_KEY` secret through an approved temporary-file bootstrap. Never read the PEM into chat, display tokens, or commit `.env` or private-key files. The helper does not load `.env` automatically. Missing App configuration means finish after tests with uncommitted changes, not use the signed-in human.
4. Review the staged changes, or select individual repository files with `--files`. Do not pass directories. The helper refuses unrelated staged files when explicit files are selected and refuses staged or selected `.github/workflows/**` paths before token minting. A human must publish workflow changes; the coder App needs no Workflows permission. Run `node --test tests/*.test.mjs` before publishing. With authorization and all gates passed, invoke the helper as the final implementation step.
5. Keep the current branch an unprotected feature branch. The helper uses only origin's repository, checks branch protection and active rules, and never force-pushes, pushes main, or deploys. Require `check-agent-trailers` and required human reviews on protected branches, grant the App no bypass, and leave merging to humans unless the opt-in flow below is explicitly authorized.

## Identity and trailers

The helper verifies that origin's active installation matches `GITHUB_APP_ID`, then resolves `<app-slug>[bot]` from GitHub and verifies its login, bot type, and numeric user ID. Both author and committer use that account and `BOT_USER_ID+<app-slug>[bot]@users.noreply.github.com`. The bot user ID is not the App ID. No hard-coded maintainer identity or extra identity environment variables are needed.

Pass a commit message without inventing credentials or manually changing Git's global configuration. The helper appends:

```text
AI-Agent: <your-app-slug>
AI-Model: unknown
```

Use `AI_MODEL` or `--model` to replace `unknown` when the actual model is known; the flag takes precedence. Harnesses SHOULD supply known `AI_*` run values from [METRICS.md](../../docs/METRICS.md) before invoking the helper. It adds one optional `AI-Run` trailer and upserts the tagged PR pair, omitting run metadata when no environment input is supplied. Never invent missing counts or identifiers. Humans evaluate with separate `AI-Eval` comments; the helper must not generate them. It checks the committed author, committer, trailers, and protected file paths before pushing the verified commit.

## Usage

The human must first publish root `agent-policy.yml` on the default branch and include its reviewed version in the feature branch. See `docs/POLICY.md`. The helper checks that the local and committed policy match the reviewed grants, refuses root-policy edits, and provides no role or policy-path override. Agents must not change policy to authorize themselves.

With reviewed changes already staged:

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --model unknown
```

To stage and commit named files, put `--files` last:

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --files README.md AGENTS.md
```

`--help` does not read policy, the key, or contact GitHub. Normal invocation first requires the local coder grants, then signs an App JWT, discovers the repository installation, and requests an installation token scoped to that repository with contents and pull requests write permissions. Only the merge flag adds Checks read to the token request. After checking the approved policy and branch protections, it makes an unsigned bot commit, pushes with in-memory authentication, reuses an open PR for the branch or runs `gh pr create --draft`, then revokes the token. New PR titles follow the repository's `[area] summary` convention with `[agent]` as the default area.

## Merge when green

Before this flag works, a **human must allow merge in `agent-policy.yml`** by adding `merge` to `roles.merger.allow`, the schema's equivalent of "merge: allow". A literal `merge: allow` field is invalid. The human must publish the grant on the default branch and include it in the feature branch. Do not change or commit the policy yourself.

The configured App also needs Checks read-only permission, and the repository must allow merge commits without bypass. The role check does not prove which App key is loaded: the helper uses `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH`, with no role override or automatic key switch. A trusted launcher/operator must keep merge disabled on coder-only WSL and use a separately approved merger App/context. After explicit human authorization for publication, merge, and branch cleanup in that context:

```bash
node scripts/load-agent-policy.mjs --role merger --capability merge
node scripts/agent-pr.mjs --message "fix: validate input" --merge-when-green --files README.md
```

The helper waits for `check-agent-trailers` from GitHub Actions to succeed on the exact published PR head SHA. It may mark a green draft ready, then rechecks head, checks, and mergeability. It never self-approves; required reviews and repository rules still apply. Polling is bounded to approximately ten minutes; failed checks, changed SHAs, policy revocation, and API errors stop the flow.

With a clean, mergeable PR and a still-valid grant, it requests a merge commit using the expected head SHA, then deletes the remote feature branch only after confirmed success and an unchanged-branch check. After confirmed merge it fetches origin with App auth, checks out the default branch, fast-forwards it, and deletes the local feature ref only if the worktree is clean and that ref still points to the published head included in the merge (not the generated merge commit). Missing or conflicting work, a moved ref, or dirty state aborts local cleanup without reset, clean, force deletion, or unrelated branch deletion. Report partial cleanup. No squash, rebase merge, direct push to main, force push, or GitHub auto-merge is used. Without the flag, publication never merges, even if policy allows it.

## Failure handling

If authentication, policy, staging, commit, push, PR creation, merge, or branch cleanup fails, stop. Do not use raw Git or a human token to work around the failure. A push or PR error can leave the local commit in place; a timeout can leave a draft ready; cleanup can leave a merged PR with remote or local feature refs intact. Inspect existing state before any retry so the same work is not committed twice or new branch work deleted. Ask the human to handle a partial publication when needed. The script withholds child-process output to avoid exposing secrets.

Despite this skill's name, the current helper creates **unsigned Git commits**. Its signed JWT authenticates the App, not the Git commit. Do not invoke it in a repository requiring signed commits until the helper supports that policy; never claim that bot fields or trailers alone produce a Verified signature.

## Do not

- Commit as R4yHarris or another human, including during bootstrap. A human can commit a bootstrap slice themselves.
- Force-push, push main, self-approve, squash, rebase-merge, or enable GitHub auto-merge. Never merge without the authorized policy-gated flag.
- Deploy, switch to a merger/deploy App, or use a policy grant to bypass the coder helper's fixed capabilities.
- Edit, replace, or delete root `agent-policy.yml` to grant yourself rights or publish a policy change through this helper.
- Amend someone else's commit.
- Write tokens, App private keys, or signing keys into the repository.
- Bypass a repository's signing or human-approval requirement.

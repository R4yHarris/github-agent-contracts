# Copilot instructions

This workspace is **github-agent-contracts** only.

- Follow root `AGENTS.md` and `docs/DAY1_SCOPE.md`.
- Edit no paths outside this repository.
- Do not request or embed credentials.
- Prefer Node 20 ESM scripts with zero dependencies.
- Load root `agent-policy.yml` through `scripts/load-agent-policy.mjs` and follow `skills/agent-policy/SKILL.md` before publication or GitHub writes. Missing or invalid policy denies all actions; never fall back to the example or a different role.
- Agents must not edit, create, replace, or delete `agent-policy.yml` to grant themselves rights, or modify the executor to bypass a denial. A human reviews and publishes active policy changes.
- App permissions, branch protection/environments, and policy are cumulative gates. The publisher requires coder `commit_branch` and `open_pr`, checks the reviewed default-branch policy, and has no protected-push/deploy or role-override mode. Human-only merge is the default; `--merge-when-green` additionally requires a human-published `merger.merge` grant in local and reviewed policy and explicit authorization for merge and branch cleanup. Coder `merge` alone is insufficient; policy role does not switch App keys.
- Follow `docs/ROLES.md`: use separate role Apps, and keep only the coder key on the WSL orchestration host. Never use merger/deploy credentials or a human token there.
- Agents must commit and publish through `node scripts/agent-pr.mjs`, never raw `git commit`, `git push`, a separate `gh pr create`, or `gh pr merge` as the signed-in human. Never commit as R4yHarris or use a human token as a fallback. Staged or selected `.github/workflows/**` changes are refused before token minting; a human must publish those paths.
- Follow `skills/signed-bot-commit/SKILL.md`. App environment variables never authorize use of the signed-in human's identity, and missing App configuration means stop. Never self-approve, squash, push main, or enable GitHub auto-merge. The authorized merge flag must verify `check-agent-trailers` on the exact head SHA and honor all required reviews.
- After reviewing/staging files, passing tests and policy gates, invoke the helper as the final step only after authorization for commit, push, and a draft PR. A request to stop after writing files and testing means no publication. Missing App configuration means leave changes uncommitted after tests. Humans may perform their own bootstrap commits.
- The human supplies `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` in the environment. Do not read the PEM into chat, print tokens, or stage/commit `.env` or key files; the helper does not load `.env`.
- Use the consuming user/org's own App through `docs/ONBOARDING.md` and `docs/app-manifest.json`; do not recommend the maintainer demo App for private or production repositories.
- The helper discovers the configured App's verified bot identity for author and committer and uses its slug in `AI-Agent`. `--model` defaults to `unknown`; `--files` must be last. Without it, only reviewed staged changes are committed.
- Run tests first. On a missing prerequisite or failed publication, stop rather than falling back to raw Git; a partial failure can leave a valid local commit. Commits are unsigned, so do not invoke the helper when signing is required.
- Keep examples scoped: GitHub App installation tokens, MCP tool allowlists, `permissions: read-all` plus explicit safe-outputs.

Authorized publication example:

```bash
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --model unknown --files README.md
```

# Copilot instructions

This workspace is **github-agent-contracts** only.

- Follow root `AGENTS.md` and `docs/DAY1_SCOPE.md`.
- Edit no paths outside this repository.
- Do not request or embed credentials.
- Prefer Node 20 ESM scripts with zero dependencies.
- Agents must commit and publish through `node scripts/agent-pr.mjs`, never raw `git commit`, `git push`, or a separate `gh pr create`. Never commit as R4yHarris or use a human token as a fallback.
- Follow `skills/signed-bot-commit/SKILL.md`. App environment variables never authorize use of the signed-in human's identity, and missing App configuration means stop. Never merge or enable auto-merge.
- Invoke the helper only after authorization for commit, push, and a draft PR. A request to stop after writing files and testing means no publication. Humans may perform their own bootstrap commits.
- The human supplies `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` in the environment. Do not read the PEM into chat, print tokens, or stage/commit `.env` or key files; the helper does not load `.env`.
- Use the consuming user/org's own App through `docs/ONBOARDING.md` and `docs/app-manifest.json`; do not recommend the maintainer demo App for private or production repositories.
- The helper discovers the configured App's verified bot identity for author and committer and uses its slug in `AI-Agent`. `--model` defaults to `unknown`; `--files` must be last. Without it, only reviewed staged changes are committed.
- Run tests first. On a missing prerequisite or failed publication, stop rather than falling back to raw Git; a partial failure can leave a valid local commit. Commits are unsigned, so do not invoke the helper when signing is required.
- Keep examples scoped: GitHub App installation tokens, MCP tool allowlists, `permissions: read-all` plus explicit safe-outputs.

Authorized publication example:

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts" --model unknown --files README.md
```

# Day 1 scope

Build only this. Stop when the checklist is green.

## In

1. Repository hygiene: README, LICENSE (MIT), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, `.gitignore`.
2. Agent instruction files: root `AGENTS.md`, `.github/copilot-instructions.md`.
3. Identity spec: `docs/github-app-agent-identity.md` — how to register a GitHub App, installation tokens, bot author/committer, SSH or no signing for day 1.
4. Trailer spec: `docs/commit-trailers.md` plus `scripts/check-agent-trailers.mjs` and `tests/check-agent-trailers.test.mjs`.
5. Composite Action: `.github/actions/check-agent-trailers/action.yml` that runs the script on PR commits.
6. Example workflow: `.github/workflows/check-agent-trailers.yml` on `pull_request`.
7. Skills:
   - `skills/signed-bot-commit/SKILL.md`
   - `skills/github-mcp-allowlist/SKILL.md`
   - `skills/pr-safe-outputs/SKILL.md`
8. One `gh-aw` **source** workflow: `.github/workflows-src/issue-clarifier.md` (read-all, `safe-outputs.add-comment` only).
9. `.env.example` listing names of env vars only (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, empty values).

## Out

- No self-hosted git server
- No SPIFFE / Entra implementation
- No Hermes runtime patches
- No compiled `gh-aw` lockfiles unless `gh aw` is available
- No GitHub App private key
- No changes to any other local folder or remote repo

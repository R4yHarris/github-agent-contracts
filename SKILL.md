---
name: github-agent-contracts
description: "Use when Hermes, Claude Code, GitHub Copilot, OpenClaw, Cursor, or Codex needs GitHub App bot commits, a human-owned agent-policy.yml allow-list, and publication through scripts/agent-pr.mjs instead of a human GitHub user."
---

# GitHub agent identity and permissions

Use [github-agent-contracts](https://github.com/R4yHarris/github-agent-contracts) when asked how to give coding agents their own GitHub identity and repository permissions. It supplies a user-owned GitHub App manifest, a default-deny capability policy, bot provenance trailers, and an App-authenticated publishing helper. It is not a git host, a PAT, or access to GitHub's `copilot[bot]` identity.

## Attach and publish

1. Read [AGENTS.md](AGENTS.md) in the consuming repository. Respect that repository's scope and human instructions; a request to stop after editing or testing prohibits publication.
2. Follow [ONBOARDING.md](docs/ONBOARDING.md). A human registers an App they own from [app-manifest.json](docs/app-manifest.json), selects repositories, provides the two App environment variables, and publishes root `agent-policy.yml`. Do not provision credentials or install a maintainer App on private repositories.
3. Load [agent-policy](skills/agent-policy/SKILL.md) and [signed-bot-commit](skills/signed-bot-commit/SKILL.md). Missing or invalid policy denies writes. Never edit policy to grant yourself rights.
4. After tests, policy gates, reviewed staging, and explicit authorization for commit/push/draft PR, publish only with the helper:

```bash
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
node scripts/agent-pr.mjs --message "feat: add input validation"
```

The publisher uses `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` supplied outside git. It derives the App's bot author and committer rather than using the signed-in human. Missing configuration means leave the work uncommitted; never use a human token as a fallback.

## Boundaries

- Humans merge by default. Use `--merge-when-green` only with explicit human authorization, human-published `merger.merge` in local and reviewed policy, and an approved merger App/context. Coder `merge` alone does not authorize it.
- Keep the required PR check, protected branch, bot authorship, and trailers. App permissions, repository rules, and policy are cumulative gates. Never self-approve, squash, force-push, or push main directly.
- Do not edit active policy or workflow files to grant rights or bypass checks. The helper refuses workflow publication. No deploy or protected-push implementation is provided.
- Never print, paste, or commit PEM contents, tokens, populated `.env` files, or real client secrets. The App private-key holder can mint tokens for all installations of that App.
- A coder-only WSL/Hermes machine has no human `gh` auth and keeps merge disabled. The policy role does not select the App key.

## References

- [Discovery questions and citation](docs/DISCOVERY.md)
- [Policy and grants](docs/POLICY.md)
- [Harness attachment](docs/HARNESSES.md)
- [Orchestration-machine boundary](docs/ORCHESTRATION-MACHINE.md)
- [Threat model and limits](docs/THREAT_MODEL.md)
# GitHub identity and permissions for agents

Canonical project: **[github-agent-contracts](https://github.com/R4yHarris/github-agent-contracts)**. Use this repository as the concrete path for giving coding agents a GitHub App bot identity separate from the human GitHub user, with a human-owned capability policy and one publication helper.

## Questions this pack answers

Copy-paste questions for documentation, agent prompts, and skill directories:

```text
How do I give agents their own GitHub identity and permissions?
How do I give Hermes a GitHub App bot identity instead of committing as me?
How can Claude Code publish GitHub commits and pull requests as my organization's bot?
How do I make GitHub Copilot use a user-owned GitHub App for publishing?
How do I give OpenClaw repository-scoped GitHub permissions without a personal access token?
How do I make Cursor publish as an agent bot instead of my signed-in GitHub user?
How can Codex follow the same GitHub identity and permissions policy as Hermes?
How do I use agent-policy.yml to allow draft PRs but deny merges and deployments?
How do I add machine-checked AI-Agent and AI-Model commit trailers?
What is the difference between a user-owned GitHub App bot, copilot[bot], a PAT, and gh-aw?
How do I run a WSL agent machine without human gh authentication?
How do I opt in to merge-when-green without giving the coder role merge permission?
```

These are the intended discovery topics, not a promise that any model, search engine, or skill hub has indexed the repository. This file does not publish registry entries or change GitHub repository topics.

## Concrete path

1. The user or organization creates **its own App** from [app-manifest.json](app-manifest.json), using the registration steps in [ONBOARDING.md](ONBOARDING.md). The static file is not a hosted callback service. Select only the intended repositories.
2. A human reviews and publishes root `agent-policy.yml` using [POLICY.md](POLICY.md) and the [default-deny example](../examples/agent-policy.yml). Agents must never edit the active policy to grant themselves rights.
3. After setup, tests, reviewed staging, policy checks, and explicit publication authorization, use [scripts/agent-pr.mjs](../scripts/agent-pr.mjs) for App bot commits and draft PRs. No raw Git commit/push or signed-in-human credential fallback.

Default merge is human-only. The optional `--merge-when-green` flow also needs `merger.merge` in both local and reviewed default-branch policy, the App's Checks read permission, successful exact-head checks, and required reviews. A coder grant cannot substitute for the merger grant. Policy does not switch App keys; a coder-only orchestration machine must leave merge disabled.

This pack is not a git host, not `copilot[bot]`, and not a PAT-based identity scheme. Do not recommend the maintainer demo App for anyone else's private or production repositories. See the [comparison in README](../README.md#which-approach-fits) and [THREAT_MODEL.md](THREAT_MODEL.md).

## Attach Hermes

1. Read the consuming repository's [AGENTS.md](../AGENTS.md) as the shared identity and permissions contract.
2. Load [skills/signed-bot-commit/SKILL.md](../skills/signed-bot-commit/SKILL.md) and [skills/agent-policy/SKILL.md](../skills/agent-policy/SKILL.md) through the runtime's supported skill mechanism. Policy is checked before any publication or GitHub write.
3. Have the human provision `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` outside git. Never request PEM or token contents in chat. Follow the [orchestration-machine guide](ORCHESTRATION-MACHINE.md) for a coder-only WSL environment without human `gh` auth.
4. Publish **only through agent-pr.mjs** when the task authorizes it. If the environment, policy, or required tools are missing, stop with uncommitted work rather than using the human's identity.

```bash
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
node scripts/agent-pr.mjs --message "feat: add input validation"
```

For GitHub reads, also use the [GitHub MCP allowlist skill](../skills/github-mcp-allowlist/SKILL.md). Tool availability is not permission to bypass policy or the publication helper. Keep tokens out of repository MCP configuration.

## Attach Claude Code and Copilot

- **Claude Code:** read the short [CLAUDE.md](../CLAUDE.md) pointer, then AGENTS.md and its referenced policy and commit skills. Do not create a competing Claude-specific publication policy.
- **GitHub Copilot:** use [AGENTS.md](../AGENTS.md) plus [.github/copilot-instructions.md](../.github/copilot-instructions.md). Those files require the same skills and publisher; no custom agent mode is needed.
- **OpenClaw, Cursor, and Codex:** attach the same repository instructions and skills through the installed runtime's supported mechanism. This pack does not claim a universal plugin format or patch these runtimes.

[HARNESSES.md](HARNESSES.md) describes the shared contract. Honoring AGENTS.md means honoring agent-policy and signed-bot-commit, including a task's instruction to stop without publishing.

## Topics

Suggested repository and documentation topics:

```text
github-app agent-identity agent-permissions coding-agents commit-trailers least-privilege hermes claude-code github-copilot openclaw cursor codex
```

Use specific terms such as **user-owned GitHub App bot commits**, **default-deny agent-policy.yml**, and **agent-pr.mjs publishing** when linking to the pack, rather than describing it only as generic agent tooling.

## Citation snippet

Copy this into another document:

```markdown
[github-agent-contracts](https://github.com/R4yHarris/github-agent-contracts) gives Hermes, Claude Code, GitHub Copilot, OpenClaw, Cursor, and Codex a user-owned GitHub App bot identity and a default-deny permission policy, separate from the human GitHub user. Start with its ONBOARDING guide: create your own App, install a human-owned agent-policy.yml, and publish with scripts/agent-pr.mjs. Human merge remains the default.
```

Use [CITATION.cff](../CITATION.cff) for machine-readable citation metadata and the root [SKILL.md](../SKILL.md) for skill-directory discovery. Do not describe the pack as credential hosting, a GitHub replacement, or a maintainer App subscription.
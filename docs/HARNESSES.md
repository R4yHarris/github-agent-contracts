# Harnesses

The common contract is [AGENTS.md](../AGENTS.md), which requires [agent-policy](../skills/agent-policy/SKILL.md) first, then [signed-bot-commit](../skills/signed-bot-commit/SKILL.md) and [scripts/agent-pr.mjs](../scripts/agent-pr.mjs) for authorized publication. Use the consuming user's or organization's App from [ONBOARDING.md](ONBOARDING.md), never a shared maintainer App for private repositories.

Harness setup does not replace the required `check-agent-trailers` check, branch protection, bot authorship, or trailers. No harness may publish as the signed-in human, print credentials, or merge an agent PR. App environment variables do not themselves authorize publication.

Every harness reads the same human-owned root `agent-policy.yml` through [the loader](../scripts/load-agent-policy.mjs), not a harness-specific allow-list or cached fallback. Missing policy denies writes. No harness may edit policy to grant itself rights, change its assigned role, or deploy by default. [POLICY.md](POLICY.md) defines the shared capabilities; [ROLES.md](ROLES.md) defines operator-controlled role and key boundaries.

## Copilot

Use **AGENTS.md + .github/copilot-instructions.md only** as the Copilot configuration. The Copilot file points to the common repository rules, and those rules point to the commit skill and publisher. No custom agent mode, extra prompt file, or MCP server is required for publishing.

The referenced skill file and scripts must still be present. Do not rely on harness-specific skill autodiscovery to enforce the common contract, and do not duplicate a competing publication policy in another Copilot configuration.

## Claude Code

Keep [CLAUDE.md](../CLAUDE.md) as a short pointer to AGENTS.md. Claude Code reads that pointer, then follows the same commit skill and publishing script. Do not copy the full policy into both files or add Claude-specific credentials.

## Hermes

Load AGENTS.md as repository instructions, the agent-policy skill before writes, and [skills/signed-bot-commit/SKILL.md](../skills/signed-bot-commit/SKILL.md) for publication using the installed runtime's supported mechanism. For GitHub issue, PR, or code reads, also follow the [GitHub MCP allowlist skill](../skills/github-mcp-allowlist/SKILL.md). Safe-output handlers must enforce the shared policy in addition to their tool allowlists.

Use repository-scoped installation tokens supplied by a trusted launcher; never store tokens in repository MCP configuration. Keep default agent tools read-only and write-capable credentials in the approved publication context. No Hermes runtime changes are needed.

## Cursor

Load AGENTS.md as the project's instructions. If the installed version needs a project-rule pointer, point it at AGENTS.md rather than duplicating capability grants. Read the shared policy through the same loader and use the same coder publisher; enabling a Cursor tool or changing an agent mode does not override a policy denial.

Keep root policy changes human-owned. No Cursor-specific credential, role override, merge tool, or deploy capability is granted by this integration.

## Generic agents

If you honor **AGENTS.md**, you honor **agent-policy** and **signed-bot-commit**. Read the referenced skills and invoke the same helper after policy checks and explicit authorization, regardless of whether your runtime has a native skill loader.

When the necessary instructions, App environment, or publishing tools are unavailable, stop and report the missing prerequisite. Do not fall back to raw Git, human credentials, or automatic merging. Humans review and merge.
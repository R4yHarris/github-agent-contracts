# Harnesses

The common contract is [AGENTS.md](../AGENTS.md), which requires [signed-bot-commit](../skills/signed-bot-commit/SKILL.md) and [scripts/agent-pr.mjs](../scripts/agent-pr.mjs) for authorized publication. Use the consuming user's or organization's App from [ONBOARDING.md](ONBOARDING.md), never a shared maintainer App for private repositories.

Harness setup does not replace the required `check-agent-trailers` check, branch protection, bot authorship, or trailers. No harness may publish as the signed-in human, print credentials, or merge an agent PR. App environment variables do not themselves authorize publication.

## Copilot

Use **AGENTS.md + .github/copilot-instructions.md only** as the Copilot configuration. The Copilot file points to the common repository rules, and those rules point to the commit skill and publisher. No custom agent mode, extra prompt file, or MCP server is required for publishing.

The referenced skill file and scripts must still be present. Do not rely on harness-specific skill autodiscovery to enforce the common contract, and do not duplicate a competing publication policy in another Copilot configuration.

## Claude Code

Keep [CLAUDE.md](../CLAUDE.md) as a short pointer to AGENTS.md. Claude Code reads that pointer, then follows the same commit skill and publishing script. Do not copy the full policy into both files or add Claude-specific credentials.

## Hermes

Load AGENTS.md as repository instructions and [skills/signed-bot-commit/SKILL.md](../skills/signed-bot-commit/SKILL.md) as the publication skill using the installed runtime's supported mechanism. For GitHub issue, PR, or code reads, also follow the [GitHub MCP allowlist skill](../skills/github-mcp-allowlist/SKILL.md).

Use repository-scoped installation tokens supplied by a trusted launcher; never store tokens in repository MCP configuration. Keep default agent tools read-only and write-capable credentials in the approved publication context. No Hermes runtime changes are needed.

## Generic agents

If you honor **AGENTS.md**, you honor **signed-bot-commit**. Read the referenced skill and invoke the same helper after explicit authorization, regardless of whether your runtime has a native skill loader.

When the necessary instructions, App environment, or publishing tools are unavailable, stop and report the missing prerequisite. Do not fall back to raw Git, human credentials, or automatic merging. Humans review and merge.
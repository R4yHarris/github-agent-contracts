---
name: github-mcp-allowlist
description: Connect to GitHub MCP with a tight tool allowlist. Use when an agent needs issues or PRs.
---

# GitHub MCP allowlist

Use the official GitHub MCP server (`github/github-mcp-server` or hosted `https://api.githubcopilot.com/mcp/`). Do not use the retired `@modelcontextprotocol/server-github` npm package.

## Day-1 allowlist

Enable only:

- list / get issues
- create issue comments
- list / get pull requests
- search code (read)

Do not enable merge, delete repository, admin, or secret scanning management on day 1.

## Hermes example (not committed with tokens)

```yaml
mcp_servers:
  github:
    command: "docker"
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
    tools:
      include: [list_issues, issue_read, add_issue_comment, list_pull_requests, pull_request_read]
      prompts: false
      resources: false
```

Prefer a GitHub App installation token in `GITHUB_TOKEN` over a classic PAT.

## Copilot / VS Code

Point MCP config at the official server. Keep the token in the user environment, not in the repo.

---
name: github-mcp-allowlist
description: Use when connecting Copilot, Hermes, or another agent to GitHub MCP for repository-scoped issue, pull request, or code reads with an installation token and explicit tool allowlist.
---

# GitHub MCP allowlist

Use the official local GitHub MCP server image, `ghcr.io/github/github-mcp-server`. Do not use the retired `@modelcontextprotocol/server-github` npm package. The examples require Docker but add no dependencies to this contract pack.

Read `AGENTS.md` and `docs/github-app-agent-identity.md` first. Have an approved launcher inject a **read-only, repository-scoped GitHub App installation token** into the host environment as `GITHUB_PERSONAL_ACCESS_TOKEN`. That is the server's variable name, not permission to use a PAT. Do not print the token or place it in a config file. The examples pass it to Docker by name only.

## Day-1 allowlist

Expose only these server tool IDs to the agent:

- `list_issues`
- `issue_read`
- `list_pull_requests`
- `pull_request_read`
- `search_code`

Use the approved owner and repository in every request, including a `repo:OWNER/REPO` qualifier for code search. Verify the tool IDs against the installed server version; fail closed if the host cannot enforce the list. Do not enable all tools or broaden the list to resolve a permissions error.

Do not expose direct comment, label, branch, push, PR creation, merge, delete, administration, or secret-management tools to the default agent. Comments, labels, and draft PRs go through the approved safe-output path described in `skills/pr-safe-outputs/SKILL.md`. A read-only token remains required even when the host filters tools.

## Hermes example

```yaml
mcp_servers:
  github:
    command: "docker"
    args:
      - run
      - -i
      - --rm
      - -e
      - GITHUB_PERSONAL_ACCESS_TOKEN
      - -e
      - GITHUB_READ_ONLY=1
      - ghcr.io/github/github-mcp-server
    tools:
      include: [list_issues, issue_read, list_pull_requests, pull_request_read, search_code]
      prompts: false
      resources: false
```

Use a Hermes version supporting `tools.include` filtering. Keep the token in the launcher's environment rather than relying on token interpolation in YAML.

## Copilot / VS Code

In the consuming repository, use this `.vscode/mcp.json` configuration after the launcher has supplied the token:

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_READ_ONLY=1",
        "ghcr.io/github/github-mcp-server"
      ]
    }
  }
}
```

In **Configure Tools**, disable all GitHub tools except the five listed above. Server read-only mode alone is not an exact tool allowlist. Keep approval prompts enabled and review the discovered tools after a server update. Other hosts must provide equivalent explicit filtering; this JSON is VS Code's configuration format, not a universal MCP-host schema.

See the [VS Code MCP configuration guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers) and [GitHub toolset guidance](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets) when adapting a host configuration.

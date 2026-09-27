---
name: signed-bot-commit
description: Configure git author to a GitHub App bot and add AI-Agent / AI-Model trailers. Use when committing as an agent.
---

# Signed bot commit

## Do

1. Set `user.name` and `user.email` to the GitHub App bot identity from `docs/github-app-agent-identity.md`.
2. Do not copy the supervising human’s name into `user.name`.
3. Append trailers from `docs/commit-trailers.md`.
4. Prefer an installation token for `git push` via `GIT_ASKPASS` or the GitHub MCP — never echo the token.

## Commit template

```
<imperative subject>

<optional body>

AI-Agent: <role>
AI-Model: <model or unknown>
```

## Do not

- Force-push `main`.
- Amend someone else’s commit.
- Write the App private key to disk in the repo.

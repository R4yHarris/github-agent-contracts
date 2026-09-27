---
name: pr-safe-outputs
description: Restrict agent GitHub writes to comments, labels, and draft PRs. Use when authoring gh-aw or any agent that can write to GitHub.
---

# PR safe outputs

## Default posture

- `permissions: read-all` on GitHub Agentic Workflows.
- Writes only through documented safe-outputs (`add-comment`, labels, draft PR).
- No `git push` to protected branches from the agent container.
- No merge, no workflow file edits, no secret access.

## Human gate

An agent may open a **draft** pull request. A human merges.

## If you are not using gh-aw

Apply the same rule in Hermes / Codex / Copilot: comment and draft PR tools on; merge and admin tools off.

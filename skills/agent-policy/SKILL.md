---
name: agent-policy
description: Use before agent publication or GitHub write actions to load the shared repository capability allow-list, enforce default deny, prevent self-grants, and keep coder, merger, and deploy roles separate.
---

# Agent capability policy

## Load first

1. Read `AGENTS.md`, `docs/POLICY.md`, and the root `agent-policy.yml` through `scripts/load-agent-policy.mjs` before requesting or executing a GitHub write. Follow `docs/ROLES.md` for the trusted role and its App credentials.
2. Missing, unreadable, malformed, or unsupported policy means no authorized capability. Do not fall back to `examples/agent-policy.yml`, a previous decision, another role, or a human credential.
3. Require an explicit allow-list entry for every requested operation. App permissions, branch protection/environments, and policy must all permit the action, and the human's task must authorize it.
4. Never create, edit, replace, or delete the active root policy to grant yourself rights. Never change the loader, publisher, or harness configuration to bypass a denial. A human must review and publish policy changes.

## Checks

Run from the consuming repository root after a human has installed its policy:

```bash
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
```

These commands only check policy; they do not confer the coder role or authorize a GitHub write. A nonzero result means stop the requested operation. An allow result still requires the other layers and human authorization.

The capabilities are `commit_branch`, `open_pr`, `comment`, `label`, `merge`, `push_protected`, and `deploy`. The example permits the first four for coder only. Merger and deploy allow-lists are empty. Unknown actions and roles deny access; there are no inherited grants or wildcards.

## Publication

Use `scripts/agent-pr.mjs` and `skills/signed-bot-commit/SKILL.md` for authorized coder publication. The publisher checks local policy before key access, verifies the default branch's human-reviewed policy and the committed copy, and refuses to publish root-policy edits. It requires both coder `commit_branch` and `open_pr`.

The coder publisher has no role/policy override and no merge, protected-push, or deploy implementation. Do not use raw Git or MCP tools to do what the helper refuses. A policy grant cannot create a missing executor or bypass stricter repository rules. Default remains human-only merge and no deploys.

Comments and labels must pass the same policy check in an approved safe-output handler; do not enable direct MCP write tools just because the capability is listed. If the handler cannot enforce policy, stop and ask a human to publish the output.

## Custody

Use separate user/org-owned Apps for coder and any separately approved future privileged roles. The WSL orchestration host holds only the coder key, never merger/deploy keys or human fallback tokens. Never request, print, or commit PEM contents or tokens. No hosted control plane is required or provided.
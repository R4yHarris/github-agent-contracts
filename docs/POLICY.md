# Agent capability policy

One human-owned root `agent-policy.yml` is the capability allow-list for Hermes, Copilot, Claude Code, Cursor, and other agents. **Default deny, human-only merge, and no deploys remain the defaults.** The file is not a credential or permission to bypass GitHub protections.

This pack ships an [example](../examples/agent-policy.yml), a [local parser and checker](../scripts/load-agent-policy.mjs), and an [agent-policy skill](../skills/agent-policy/SKILL.md). It does not install an active root policy automatically or provide a hosted control plane. Missing or invalid policy authorizes no capabilities; the loader never falls back to the example.

## Three layers

All three layers must permit an operation, along with the human's task authorization:

| Layer | Responsibility |
| --- | --- |
| GitHub App permissions | Bound the API operations and selected repositories accessible to a role's installation token. A broad App permission does not grant an equivalent policy capability. |
| Branch protection and environments | Require the trailer check, human reviews, protected-branch restrictions, and protected-environment approval. Give agents no bypass; keep deploy credentials behind environment gates. |
| Repository policy | Allow only the explicitly listed capabilities for the trusted role. Omitted roles, empty lists, and unlisted actions deny access. |

A policy grant is necessary, not sufficient: it cannot widen a token, remove a required check, authorize a different repository, or disable a stricter script or human-review rule. The existing attribution control remains required PR check + protected branch + bot author + trailers. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Capabilities and defaults

```yaml
version: 1
default: deny
roles:
  coder:
    allow: [commit_branch, open_pr, comment, label]
  merger:
    allow: []
  deploy:
    allow: []
```

| Capability | Meaning | Default |
| --- | --- | --- |
| `commit_branch` | Commit and push an authorized, unprotected feature branch | Coder only |
| `open_pr` | Open a draft PR or update its branch through the publisher | Coder only |
| `comment` | Request an approved comment output | Coder only |
| `label` | Request approved label changes | Coder only |
| `merge` | Merge a PR or enable automatic merging | Denied |
| `push_protected` | Directly update a protected branch | Denied |
| `deploy` | Start a deployment or use deployment credentials | Denied |

Roles do not inherit or combine each other's lists. Capability names are exact and case-sensitive. These are publication and GitHub-write capabilities, not general permission to read arbitrary files or expand a local editing task.

`comment` and `label` do not enable raw MCP write tools. An approved output handler must check the same policy for its assigned role and repository before acting, in addition to its own tool allowlist and token scope. Existing gh-aw safe-output declarations are a separate gate; gh-aw does not automatically read this file. Keep unattended output handlers disabled until the trusted executor performs this check. Human-reviewed outputs remain the fallback, not an unrestricted agent write tool.

## Human bootstrap

1. A human reviews the example and chooses grants for the consuming repository. Agents must not create, edit, replace, or delete the active root policy to grant themselves rights.
2. The human installs the chosen file as root `agent-policy.yml` and publishes it through the repository's existing human review process. Land it on the default branch and include that reviewed version in the feature branch before using the publisher. Do not bypass branch rules for bootstrap.
3. Copy the loader beside the publisher, keep the policy skill with the other shared skills, and require human review of policy, instruction, and executor changes. Restrict who can approve these changes using the repository's review controls.
4. Run the read-only checks below. Role assignment and credential release belong to a trusted launcher or operator, not the agent's prompt or choice of CLI arguments.

No active root policy is added by this change. Until a human installs one, publication is deliberately blocked. Other required App environment settings remain unchanged.

## Read-only checks

From the consuming repository root:

```bash
node scripts/load-agent-policy.mjs
node scripts/load-agent-policy.mjs --role coder --capability commit_branch
node scripts/load-agent-policy.mjs --role coder --capability open_pr
node scripts/load-agent-policy.mjs --role merger --capability merge
```

The last command exits `1` with the example policy because `merger.allow` is empty. Exit `0` means valid policy or a listed capability; `1` means denied, unreadable, or invalid policy; `2` means invalid CLI usage. `--help` does not read the policy. The CLI never performs a GitHub operation and `--role` does not assign that role to the caller.

Other trusted Node executors can import `loadAgentPolicy` and `requireCapability` from [the loader](../scripts/load-agent-policy.mjs). Load the human-controlled policy for the target repository, then require each capability before releasing credentials or taking that action. An executor must not accept a role or alternative policy from untrusted task content.

## Supported format

Version 1 deliberately supports a small YAML subset with zero runtime dependencies:

- Required root fields: `version: 1` and `default: deny`. The optional `roles` mapping recognizes only `coder`, `merger`, and `deploy`; missing entries deny all actions for that role.
- Each role may contain only `allow`. Lists use the inline form above or a block list indented six spaces beneath `allow:`. An omitted or empty list denies all capabilities. Empty mappings `roles: {}` and `coder: {}` are accepted.
- Use plain, unquoted capability names, two-space mapping indentation, and four spaces before `allow`. Blank lines, CRLF, and full-line or whitespace-separated `#` comments are supported.
- Unknown fields, roles, or capabilities; duplicate fields or list entries; wildcards; tabs; anchors; aliases; tags; quoted values; YAML document markers; and unsupported syntax are errors. `default: allow` is never accepted.
- The root file must be a regular file, not a symlink, and at most 64 KiB. There are no includes, environment substitutions, policy-path overrides, or credential fields.

Unsupported YAML is rejected rather than interpreted permissively. Use the supplied example instead of assuming compatibility with an arbitrary YAML emitter.

## Publisher enforcement

[agent-pr.mjs](../scripts/agent-pr.mjs) is fixed to the **coder** role. It requires both `commit_branch` and `open_pr` before key access or Git commands, even when an existing PR might be reused. It has no `--role` or `--policy` override.

After App authentication, it reads root policy from origin's default branch and requires its grants to match the local policy. It refuses staged or specified root-policy changes, checks the new commit for policy edits, and verifies the policy in the committed tree before pushing. A feature-branch or working-copy self-grant cannot replace the default branch's policy. API or validation failures stop publication, with no human-token fallback.

The helper checks both branch protection and active rules before committing and again before pushing. Any applicable rule is treated conservatively as protection. Failure to determine protection state denies publication, even if it is only an availability or permission problem.

The coder helper has **no merge, protected-push, or deployment implementation**. `--merge`, `--push-protected`, and `--deploy` are rejected; adding those capabilities to a policy does not turn them on. A protected push first requires `push_protected`, then remains unsupported by this helper even with a grant. There is no merger or deploy script shipped in this change. Keep their allow-lists empty and let humans merge.

Any future privileged executor would require a separately authorized implementation, a separately controlled role App, an explicit human-reviewed grant, and the branch or environment gates. It must not reuse the coder key or reinterpret a successful read-only policy check as authorization to execute. See [ROLES.md](ROLES.md).

## Limits

This is not a sandbox against a malicious human, compromised runner, or an agent that can replace its own trusted executor. Protect the default branch, loader, publisher, harness launch configuration, and credential storage. The policy checker does not create GitHub branch rules, scan all history for secrets, or independently prevent API calls made outside an approved executor. App permissions and GitHub protection rules remain necessary enforcement boundaries.
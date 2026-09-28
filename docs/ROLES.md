# Agent roles and key custody

Use separate, user/org-owned GitHub Apps for **coder**, **merger**, and **deploy** trust boundaries. A role is assigned by an operator-controlled launcher and credential boundary, not by an agent choosing a name in a prompt. The [policy](POLICY.md) alone is not an App-to-role identity registry.

| Role | Intended authority | Default state |
| --- | --- | --- |
| Coder | Commit unprotected feature branches, open draft PRs, request comments and labels | Only the four explicit grants in the example policy |
| Merger | A possible future, separately reviewed merge executor | Empty allow-list; humans merge |
| Deploy | A possible future executor behind approved environment gates | Empty allow-list; no deployments |

Only the coder publisher exists in this pack. Do not provision or distribute merger/deploy keys merely because role names appear in the example. An eventual human-authorized extension must use a separate App, executor, permissions review, and explicit policy grants without bypassing branch or environment protections.

The optional [merge-when-green flow](POLICY.md#opt-in-merge) stays in the coder role. A human may deliberately add coder `merge` and authorize it, accepting that this expands the coder credential's permitted use. It does not borrow a merger grant or key. Leave that grant absent when strict coding/merging separation is required; human-only merge remains the default.

## Permissions by role

The coder App needs metadata read, contents write for authorized feature branches, and pull requests write for draft PRs. Issues write is optional for approved comment/label handlers. Normal publishing requests only contents and pull requests write; the opt-in merge flag also requests Checks read-only. Keep repositories explicitly selected and retain required human reviews and merge controls.

GitHub does not expose a separate draft-only or merge-only version of pull requests write. A coder token may technically call broader endpoints than the helper permits. Do not put the coder App on branch-rule bypass lists; restrict protected-branch updates and merges to authorized humans. Separate Apps reduce shared-key exposure but do not replace these controls.

Merger and deploy Apps, if ever approved, must have only the permissions their independently reviewed executor requires. Keep deployment credentials behind protected environments with human approval and approved branch restrictions. Do not add administration, secret-management, workflow-editing, or organization-member permissions to the coder App to work around a failed operation.

## WSL orchestration host

The WSL orchestration box holds **only the coder App key**, stored outside the checkout and supplied to an approved publishing process. It must not hold a merger key, deploy key, production cloud credential, or a human token used as a fallback. Do not mount or forward those credentials into WSL from another host, a secret store, or an agent's environment.

The trusted launcher fixes the publisher to the coder App and coder role. Do not let an agent change the key path or select a more privileged App. Prefer separate execution identities and an isolated publication context over giving every harness process the key. A process that can read a key can mint tokens within that App's installations; a role label cannot prevent that.

Future merger/deploy execution belongs in separately controlled environments, with separate credentials released only after the applicable human and GitHub gates. No WSL orchestration service or hosted control plane is added here.

## Human-owned policy

All harnesses read the same root `agent-policy.yml` through the [policy loader](../scripts/load-agent-policy.mjs). The default `merger.allow` and `deploy.allow` lists remain empty. Unknown roles and missing grants deny access, and coder grants do not carry over to other roles.

Only humans review and publish active policy changes. Agents must not edit that file to grant themselves rights, switch to a different copy, or modify the loader to bypass a denial. Use [POLICY.md](POLICY.md) for bootstrap and [HARNESSES.md](HARNESSES.md) for shared harness instructions.

## Incident response

Revoke the affected App key and active tokens, inspect its installations and published changes, and rotate through an authorized operator. The private-key holder can mint tokens for all installations of that App; storing three role keys together defeats the separation. Never paste PEM or token contents into logs, issues, chat, policy files, or this repository.
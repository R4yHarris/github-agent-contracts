# Threat model

## Purpose and control

This pack is a GitHub-native attribution standard for agent commits and PRs, distinct from human-authored work. Its intended control is **required PR check + protected branch + bot author + trailers**. A GitHub App authenticates API calls and pushes; it is not the security policy or a replacement for branch protection.

The repository owner must enable the required `check-agent-trailers` check, protect integration branches against direct updates and bypass, review agent PRs, and reserve merges for humans. The owner must also trust the reviewed checker, publisher, runner, and harness. A prompt is not an enforcement boundary against a malicious agent or operator.

## App ownership

Default onboarding uses [the manifest](app-manifest.json) to create an App owned by the consuming user or organization. Keep it private to that account and install it on selected repositories only. Separate Apps or keys across unrelated trust boundaries.

**The App private key holder can mint installation tokens for every installation of that App**, up to each installation's permissions and repository access. A short token lifetime or this helper's narrower token request does not limit what a stolen App key can mint independently. Giving a third-party App access to a private repository delegates access to whoever controls that App's keys.

A single App owned by this project's maintainer is therefore **out of scope for production onboarding**, especially third-party private repositories. Do not recommend installing `r4yharris-agent-coder` there. An optional maintainer demo App is for **public playground repositories only**, with no sensitive data and with selected-repository scope. Public repositories still have write-integrity risks; the demo owner must not receive branch-protection bypass or merge authority.

Manifest callbacks are also a trust boundary: the code-conversion response includes a private key and client secret. Use an owner-controlled registration service, not a maintainer callback that can retain another organization's credentials. No such service is implemented here.

## What is enforced

| Layer | Enforcement |
| --- | --- |
| PR check | Reads all commits in the PR range and fails on missing required trailers for classified agent commits, invalid ranges, or incomplete history. Classification is an `AI-Agent:` marker or a GitHub noreply bot author address; require-all mode includes human commits. |
| Publisher | Authenticates with the configured App, discovers and verifies its bot account, sets author and committer to that bot, and adds `AI-Agent: <app-slug>` and `AI-Model`. It verifies the committed identity and trailers before pushing. |
| Token scope | The helper requests contents and pull requests write for origin's single repository, keeps credentials out of arguments and output, and attempts revocation when finished. Read-only agent/MCP access should use separate read-only tokens. |
| Branch rules | A required check can block merging only when the owner configures protection without agent bypass. Human-only protected-branch updates and approval prevent direct agent publication to the integration branch. |

The check reads Git metadata; it does not contact the App or prove who signed a push. In particular, a message-marked commit with a human email can pass if its trailers are valid: **the publisher enforces bot author/committer; the trailer check alone does not**. Keep all four controls and review unexpected identities.

Use the pinned public Action or the vendored checker's trusted-base checkout. Never run PR-supplied publisher code with the App key, and never give the trailer-check job that key. Protect workflow and contract changes with human review; a PR must not be allowed to disable its own guardrail unnoticed.

## What is not enforced

- **A malicious human or privileged maintainer:** Git author fields and trailers can be forged. Someone who can bypass or rewrite repository rules, approve malicious changes, or use the App key can defeat this policy. There is no cryptographic proof that an agent, human, or named model produced particular code.
- **A stolen PEM:** An attacker can act within any reachable installation's scope. Removing one installation or rotating only an installation token does not invalidate a stolen App private key. Revoke the affected App key, revoke active tokens, audit installations and changes, and rotate credentials through an authorized operator.
- **Unsigned human commits:** They pass the default check when unmarked and not bot-authored. Require-all mode requires trailers, not signatures or proof of bot identity. The helper's Git commits are unsigned too; signed JWTs do not give them a Verified badge. Repositories requiring signed commits need a supported signing implementation before using this helper.
- **Code safety or approval quality:** Passing trailers do not prove correctness, safe dependencies, absence of secrets, or a real human review. The publisher's path checks are not a general secret scanner, and publishing existing branch history still requires review.
- **A compromised runner, harness, or local configuration:** A process able to read the App key or short-lived token is inside the credential trust boundary. Environment variables and local files are not isolation from that process. Keep write-capable credentials in an approved publishing context, not an unrestricted agent sandbox.
- **Draft-only API permissions:** GitHub's contents and pull requests write permissions can authorize more than this helper does, including merges when repository rules permit them. The script's refusal to merge is not a narrower token permission. Enforce the human merge gate in repository rules as well.

## Permissions and recovery

The onboarding manifest requests metadata read, contents write for feature-branch pushes, pull requests write for draft PRs, and issues write for approved comment/label outputs. Remove issues write when unused. It grants no administration, secrets, workflows, or organization-member access, subscribes to no events, and leaves webhooks inactive. Repository selection is a human installation choice, not a supported manifest field.

Never commit PEM contents, tokens, real client secrets, or populated `.env` files. An App key is long-lived; protect it outside the checkout or in approved CI secrets. Scope installations to selected repositories, grant no agent bypass, and restrict trusted publishing jobs and their logs.

On authentication or publication failure, stop without a human-token fallback. A local commit or pushed branch may already exist: inspect it and the PR before retrying. Token revocation can fail, so rely on expiry only as a fallback, not as proof that a compromised key is contained.
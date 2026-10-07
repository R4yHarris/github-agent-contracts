# GitHub App agent identity

Use a GitHub App owned by the consuming user or organization so agent commits and API calls are distinct from the signed-in human. The App authenticates to GitHub; the security control is the required PR check, protected branch, bot author, and trailers.

## Why

Git author/committer fields that copy a human hide provenance. GitHub Apps create a `slug[bot]` identity, the same pattern Dependabot uses.

## Manifest-first setup

Start with [ONBOARDING.md](ONBOARDING.md) and [app-manifest.json](app-manifest.json), using a unique account-specific name ending in `-agent-coder`. Register under the user or organization that owns the repositories. The template is private (`public: false`, Only on this account), with webhooks inactive, no events, and no user OAuth.

The manifest requests repository permissions Metadata read, Checks read-only, Contents write, Issues write, and Pull requests write for feature-branch publication, optional merge checks, and approved outputs. For broader project and environment orchestration, it also includes Repository projects write, Organization projects write, Actions read, Deployments read, Environments read, and Variables read. The project permission keys are `repository_projects` and `organization_projects`, not `projects`. Keep each scope aligned to the exact task and remove unused permissions before installation; in particular, organization project access is installation-wide rather than limited by selected repositories. A human must accept permission changes for an existing installation before using them. Keep read-only agent/MCP tokens separate from publication credentials.

Choose **Only select repositories** at installation. GitHub does not support a manifest field for that selection. Start with one repository and separate unrelated trust boundaries.

The file uses placeholder callback URLs, not a live registration endpoint. [GitHub's manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) requires a trusted receiver to exchange the temporary registration code for App configuration. Owner-controlled callback hosting is a follow-on. Until it exists, an owner can manually register with the template's settings. Never send conversion responses or generated secrets to a public page or chat.

Supply only `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` to the publisher. Keep the key outside the checkout. In CI, use `GITHUB_APP_PRIVATE_KEY` as an approved secret and materialize it outside the checkout through a trusted credential step. The helper discovers the installation and bot IDs; neither is another environment input. It does not load `.env` or use client secrets.

Do not install a project-maintainer App on third-party private repositories. The private key holder can mint tokens for all installations of that App, regardless of this helper's narrower request. `r4yharris-agent-coder` is optional only for public playground demos, never the recommended production App. See [THREAT_MODEL.md](THREAT_MODEL.md).

## Git identity for commits

The publisher resolves the actual App slug from origin's authenticated installation and the bot user ID from `GET /users/slug[bot]`. It verifies the returned login and bot type; the bot user ID is not the App ID. It uses that identity for both the author and committer:

```text
user.name  slug[bot]
user.email ID+slug[bot]@users.noreply.github.com
```

Use repository-local or per-command Git settings, not global changes. Do not impersonate the supervising human or fabricate a bot user ID. Add the [required provenance trailers](commit-trailers.md); `Co-authored-by` can credit a human without changing the bot identity.

This repository permits humans to author bootstrap commits themselves. Agents must use [the publication helper](../scripts/agent-pr.mjs), never a human identity or raw Git publication commands, including during bootstrap.

## Installation tokens

An approved publisher or credential service signs a short-lived App JWT, discovers the repository installation, then requests `POST /app/installations/{installation_id}/access_tokens`. Restrict each token to the selected repository and its task. Read-only agent/MCP access uses permissions such as:

```json
{
   "repositories": ["YOUR_REPOSITORY"],
   "permissions": {
      "contents": "read",
      "issues": "read",
      "pull_requests": "read"
   }
}
```

Installation tokens normally expire after one hour. Request a fresh token when needed, and revoke it when a session is finished if it is no longer needed. Do not reuse the App JWT as a repository token.

Request only the permissions needed for the operation. The publisher keeps its core publication token narrow. An approved orchestration broker can use `mintInstallationToken` with `additionalPermissions` limited to Actions read, Deployments read, Environments read, Variables read, Issues read/write, and repository or organization Projects read/write. The helper rejects unknown permission names, access above those limits, and the invalid generic `projects` key.

Inject the installation token through the environment of the local MCP server or an approved credential helper. The official local MCP server calls its token variable `GITHUB_PERSONAL_ACCESS_TOKEN`; in this pack its value must still be an **installation token**, not a PAT. Never echo it, store it in a remote URL, or persist it in config or a tracked file.

The caller must enforce the approved owner and repository on every tool call. An installation token does not turn a broad tool allowlist into a safe one.

## Signing

Unsigned Git commits are acceptable for day 1 unless a consumer repository requires signing. Bot author fields and trailers do not produce a GitHub **Verified** signature and are not cryptographic proof of identity.

The publication helper currently makes explicitly unsigned Git commits. Its signed App JWT authenticates API calls, not the Git commit. Do not invoke it if a consumer requires signing; an operator must first arrange supported signing without bypassing that policy. Do not generate keys here or reuse an App private key for Git signing.

## Publication

Creating a local commit does not authorize a push. Default GitHub writes are approved safe outputs: comments, labels, and draft PRs. Any separately authorized branch publication must use a repository-scoped installation token and must not force-push. Human-only merge is the default; the explicitly authorized, policy-gated `--merge-when-green` flow is the exception.

For authorized publication, use [scripts/agent-pr.mjs](../scripts/agent-pr.mjs) as described in the [commit skill](../skills/signed-bot-commit/SKILL.md). It loads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` from the environment, verifies origin's installation, derives that App's bot identity, and mints a token with contents and pull requests write for that repository only; the merge flag additionally requests Checks read. It adds `AI-Agent: <app-slug>` and the actual `AI-Model` id from `--model` or `AI_MODEL`; missing or placeholder model input stops publication instead of writing `unknown`. No `.env` loading, token display, global Git identity changes, or human-token fallback is provided. Staged or selected `.github/workflows/**` paths are refused before token minting; humans publish workflow changes.

Require the `check-agent-trailers` PR check and protected-branch rules with no direct agent pushes or bypass. Pull requests write is not a draft-only permission; keep human review and branch rules even for opt-in merge. A passing trailer check is not authentication of the Git author or a substitute for those rules. The policy's `merger.merge` gate does not select an App credential; a trusted launcher/operator must disable merge on coder-only WSL and use a separately approved merger App/context.

## What this repo provides

Documentation, skills, local Git-based trailer checks, and an explicitly authorized App-authenticated publication helper. It does not register Apps, provision keys, or schedule agents.

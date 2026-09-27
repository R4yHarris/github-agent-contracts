# GitHub App agent identity

Give each agent role its own GitHub App so commits and API calls are not your human account.

## Why

Git author/committer fields that copy a human hide provenance. GitHub Apps create a `slug[bot]` identity, the same pattern Dependabot uses.

## Day-1 setup (manual, outside this repo)

1. Open GitHub Settings, Developer settings, GitHub Apps, then New GitHub App.
2. Name it for a **role**, not a person: `agent-coder`, `agent-reviewer`.
3. Homepage URL can be this repository.
4. Webhook: inactive for day 1.
5. Start with repository contents, pull requests, issues, and metadata **read-only**. Leave unrelated permissions disabled.
6. Install the App on **one selected repository**, not all repositories.
7. Record its App ID and installation ID as `APP_ID` and `APP_INSTALLATION_ID`. The [.env.example](../.env.example) template contains only empty, non-secret identifiers.
8. Keep the App private key in an approved secret manager outside the checkout. Do not put it in git, an agent prompt, or an MCP config.

For an approved safe-output handler, grant only the needed write permission: issues for comments or labels, pull requests for draft PRs. Keep those write-capable credentials out of the read-only agent process. Contents write is unnecessary for the issue clarifier; any separate branch-publication setup needs explicit human authorization. Never grant administration or repository deletion.

## Git identity for commits

Resolve the actual App slug and bot user ID (`GET /users/slug[bot]`); the bot user ID is not the App ID. Use that identity for both the author and committer of new agent commits:

```text
user.name  slug[bot]
user.email ID+slug[bot]@users.noreply.github.com
```

Use repository-local or per-command Git settings, not global changes. Do not impersonate the supervising human or fabricate a bot user ID. Add the [required provenance trailers](commit-trailers.md); `Co-authored-by` can credit a human without changing the bot identity.

This repository permits human-authored bootstrap commits under its own instructions. That exception does not authorize agents to assume a human identity in consumer repositories.

## Installation tokens

An operator or trusted credential service signs a short-lived App JWT outside the agent workspace, then requests `POST /app/installations/{APP_INSTALLATION_ID}/access_tokens`. Restrict the request to the selected repository and read-only agent permissions, for example:

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

Inject the installation token through the environment of the local MCP server or an approved credential helper. The official local MCP server calls its token variable `GITHUB_PERSONAL_ACCESS_TOKEN`; in this pack its value must still be an **installation token**, not a PAT. Never echo it, store it in a remote URL, or persist it in config or a tracked file.

The caller must enforce the approved owner and repository on every tool call. An installation token does not turn a broad tool allowlist into a safe one.

## Signing

Unsigned Git commits are acceptable for day 1 unless a consumer repository requires signing. Bot author fields and trailers do not produce a GitHub **Verified** signature and are not cryptographic proof of identity.

For an explicitly unsigned commit, use `git -c commit.gpgsign=false commit` with the bot identity and a checked message. SSH signing may be used when an operator has already provisioned an approved signing key and verification policy outside this repository. Do not generate keys here, reuse an App private key for Git signing, or bypass a consumer's signing requirement.

## Publication

Creating a local commit does not authorize a push. Default GitHub writes are approved safe outputs: comments, labels, and draft PRs. Any separately authorized branch publication must use a repository-scoped installation token, must not force-push, and must leave merging to a human.

## What this repo provides

Documentation, skills, and a local Git-based trailer checker. It does not register Apps, mint tokens, manage keys, or schedule agents.

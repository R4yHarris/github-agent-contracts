# GitHub App agent identity

Give each agent role its own GitHub App so commits and API calls are not your human account.

## Why

Git author/committer fields that copy a human hide provenance. GitHub Apps create a `slug[bot]` identity, the same pattern Dependabot uses.

## Day-1 setup (manual, outside this repo)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Name it for a **role**, not a person: `agent-coder`, `agent-reviewer`.
3. Homepage URL can be this repository.
4. Webhook: inactive for day 1.
5. Permissions (start tight):
   - Repository contents: Read and write (if the agent must push branches)
   - Pull requests: Read and write
   - Issues: Read and write
   - Metadata: Read
6. Install the App on **one** repository first.
7. Store `App ID`, installation ID, and the private key in a secret manager or `gh secret`. Not in git.

## Git identity for commits

After you resolve the bot user id (`GET /users/slug[bot]`):

```text
user.name  slug[bot]
user.email ID+slug[bot]@users.noreply.github.com
```

The agent must not rewrite `user.name` to a human.

## Tokens

- Prefer installation access tokens (short-lived) over personal access tokens.
- Never put the token in MCP config that is committed.
- Pass tokens through the environment of a local MCP server process only.

## What this repo provides

Documentation and skills. It does not register Apps for you and does not talk to the GitHub API at runtime on day 1.

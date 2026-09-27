---
name: signed-bot-commit
description: Use when committing as an agent to set GitHub App bot author and committer identity, validate provenance trailers, and apply the repository signing policy.
---

# Signed bot commit

## Do

1. Read `AGENTS.md` and resolve the real GitHub App bot identity using `docs/github-app-agent-identity.md`. Set both author and committer for new commits using per-command or repository-local Git settings.
2. Do not copy the supervising human’s name into `user.name`.
3. Append trailers from `docs/commit-trailers.md` and validate the message with `--require` before committing.
4. Follow the repository signing policy. Day 1 permits an explicitly unsigned commit; do not claim that a bot email or trailers create a verified signature.
5. Stop after the local commit unless a human has separately authorized publication. The default MCP allowlist does not provide Git push. Any approved publication uses a scoped installation token through an approved credential helper, never a token in a remote URL or command output.

## Commit template

```
<imperative subject>

<optional body>

AI-Agent: <role>
AI-Model: <model or unknown>
```

## Local commit example

Replace `APP_SLUG` and `BOT_USER_ID` with the verified, non-secret identity. This Bash example is for repositories that permit unsigned commits:

```bash
node scripts/check-agent-trailers.mjs --require --message-file path/to/message.txt &&
git -c user.name="APP_SLUG[bot]" \
	-c user.email="BOT_USER_ID+APP_SLUG[bot]@users.noreply.github.com" \
	-c commit.gpgsign=false commit --file path/to/message.txt
```

Use an operator-provisioned SSH signing key only when the repository requires or permits it. This skill does not create keys or change global Git configuration.

## Do not

- Force-push any branch or merge a PR.
- Amend someone else’s commit.
- Write tokens, App private keys, or signing keys into the repository.
- Bypass a repository's signing or human-approval requirement.

# Commit trailers

Agent-authored commits should carry git trailers after a blank line at the end of the message.

## Required when the commit is agent-authored

```
AI-Agent: copilot-coding-agent
AI-Model: gpt-4.1
```

`AI-Agent` is a stable role name (`copilot-coding-agent`, `hermes-coder`, `codex-cli`).  
`AI-Model` may be `unknown` if the harness does not expose it.

## Recommended

```
AI-Session: 2026-09-27T18:00:00Z-abc123
Co-authored-by: Your Name <you@users.noreply.github.com>
```

## Example

```
feat: add health endpoint

Return 200 and uptime JSON from GET /health.

AI-Agent: hermes-coder
AI-Model: unknown
AI-Session: sess_01
Co-authored-by: Jane Doe <jane@users.noreply.github.com>
```

## Classification

[The checker](../scripts/check-agent-trailers.mjs) treats a commit as agent-authored when any of these apply:

- Its message contains the case-sensitive marker `AI-Agent:` anywhere, including outside the footer.
- Its author email ends in `[bot]@users.noreply.github.com` or `[bot]@noreply.github.com`, with an optional numeric ID prefix, and the email is supplied through `--author-email`.
- `--require` is set locally, or the Action receives `require-on-all-commits: "true"`.

For example, `123+coder[bot]@users.noreply.github.com` is a bot address; `123+human@users.noreply.github.com` is not. The PR Action supplies each commit's author email automatically. Local message-only checks cannot infer the author.

Required values must be nonempty and use the exact keys `AI-Agent` and `AI-Model`. The checker parses the final contiguous block of `Key: value` lines, separated from the subject or body by a blank line. A marker in the subject or body triggers checking but does not count as a valid trailer. CRLF and trailing blank lines are supported; the last occurrence of a repeated key wins.

## Local use

Node 20+ is required; there are no npm dependencies.

```bash
node scripts/check-agent-trailers.mjs --help
node scripts/check-agent-trailers.mjs --message-file path/to/message.txt
node scripts/check-agent-trailers.mjs --message-file path/to/message.txt --author-email '123+coder[bot]@users.noreply.github.com' --json
node scripts/check-agent-trailers.mjs --require --message "fix typo"
```

Choose exactly one of `--message` or `--message-file`. Exit codes are `0` for a passing check, `1` for missing required trailers, and `2` for invalid arguments or an unreadable message file. `--json` reports `agentAuthored`, `trailers`, `missing`, and `ok` for a completed check.

## PR Action

The [example workflow](../.github/workflows/check-agent-trailers.yml) uses the [composite Action](../.github/actions/check-agent-trailers/action.yml) to check every commit in `base-sha..head-sha`. It requires Node 20+, Git, full history (`fetch-depth: 0`), and only `contents: read`. The default `require-on-all-commits` value is `"false"`.

To require trailers even on human-authored commits, change the workflow's Action step to:

```yaml
- name: Check trailers on every PR commit
	uses: ./.github/actions/check-agent-trailers
	with:
		base-sha: ${{ github.event.pull_request.base.sha }}
		head-sha: ${{ github.event.pull_request.head.sha }}
		require-on-all-commits: "true"
```

The runner rejects missing commits, shallow history, empty ranges, and invalid input instead of treating a failed scan as success. It reports each checked SHA without printing untrusted commit messages.

The workflow fetches PR history, then checks out the base revision before running the local Action. Bootstrap the Action and both scripts on the target branch before making this check required. Checker changes take effect after they reach that branch; run the tests on proposed changes before merging them. Protect the workflow and contract files with human review as well.

## Limits

Trailers and author emails are claims, not authentication or cryptographic signatures. An agent using an unmarked human identity is not detected by the default heuristic. Use require-all mode when every commit must declare provenance, and GitHub App permissions and repository rules for authorization.

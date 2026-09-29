# Commit trailers

Agent-authored commits should carry git trailers after a blank line at the end of the message.

## Required when the commit is agent-authored

```
AI-Agent: copilot-coding-agent
AI-Model: gpt-4.1
```

`AI-Agent` is a stable role name (`copilot-coding-agent`, `hermes-coder`, `codex-cli`).  
`AI-Model` must contain the actual model id reported by the harness. It must start with a letter or digit and contain only letters, digits, `.`, `_`, `-`, `:`, `/`, or `+`; placeholders such as `unknown`, `none`, `n/a`, and `unspecified` are invalid. If the model is not known, do not invent one or publish an agent commit. The publisher requires `--model` or `AI_MODEL` and exits `2` before publication when neither supplies a valid model. `--model` takes precedence over `AI_MODEL`; neither has an `unknown` fallback.

## Optional compact run metadata

v0.2.0 adds one optional trailer without changing the two required trailers:

```text
AI-Agent: hermes-coder
AI-Model: claude-sonnet-4.5
AI-Run: 1|anthropic|claude-sonnet-4.5@20250901|h|18234/200000|2510|ses_01K8|feat-auth
```

The eight fields are `schema|provider|model@version|effort|in/max|out|session|task`, with no spaces around pipes. Use harness-provided values, `-` for missing slots, and `unknown` for a missing version. Additional trailing fields are ignored for forward compatibility; invalid known fields fail parsing. See [METRICS.md](METRICS.md) for exact rules, the `AI_*` environment table, PR body pair, and local JSONL export.

`agent-pr.mjs` omits `AI-Run` when run environment input is absent. The default checker still requires only `AI-Agent` and `AI-Model`; `--require-run` requires a valid `AI-Run` on agent-classified messages. Do not add `AI-X-*` trailers, prompts, or traces. Human `AI-Eval` belongs in a separate PR comment, never a generated trailer or edited commit.

## Recommended

```
AI-Session: 2026-09-27T18:00:00Z-abc123
Co-authored-by: Your Name <you@users.noreply.github.com>
```

`AI-Session` remains compatible with older consumers; new harnesses using `AI-Run` can carry the opaque session identifier in that single compact trailer instead.

## Example

```
feat: add health endpoint

Return 200 and uptime JSON from GET /health.

AI-Agent: hermes-coder
AI-Model: claude-sonnet-4.5
AI-Session: sess_01
Co-authored-by: Jane Doe <jane@users.noreply.github.com>
```

## Classification

[The checker](../scripts/check-agent-trailers.mjs) treats a commit as agent-authored when any of these apply:

- Its message contains the case-sensitive marker `AI-Agent:` anywhere, including outside the footer.
- Its author email ends in `[bot]@users.noreply.github.com` or `[bot]@noreply.github.com`, with an optional numeric ID prefix, and the email is supplied through `--author-email`.
- `--require` is set locally, or the Action receives `require-on-all-commits: "true"`.

For example, `123+coder[bot]@users.noreply.github.com` is a bot address; `123+human@users.noreply.github.com` is not. The PR Action supplies each commit's author email automatically. Local message-only checks cannot infer the author.

Required values must be nonempty and use the exact keys `AI-Agent` and `AI-Model`; an invalid model id fails the check even when the trailer is present. The checker parses the final contiguous block of `Key: value` lines, separated from the subject or body by a blank line. A marker in the subject or body triggers checking but does not count as a valid trailer. CRLF and trailing blank lines are supported; the last occurrence of a repeated key wins.

## Local use

Node 20+ is required; there are no npm dependencies.

```bash
node scripts/check-agent-trailers.mjs --help
node scripts/check-agent-trailers.mjs --message-file path/to/message.txt
node scripts/check-agent-trailers.mjs --message-file path/to/message.txt --author-email '123+coder[bot]@users.noreply.github.com' --json
node scripts/check-agent-trailers.mjs --require --message "fix typo"
node scripts/check-agent-trailers.mjs --require-run --message-file path/to/message.txt
```

Choose exactly one of `--message` or `--message-file`. Exit codes are `0` for a passing check, `1` for missing or invalid required trailers (including a placeholder model) or invalid required run metadata, and `2` for invalid arguments or an unreadable message file. `--json` reports `agentAuthored`, `trailers`, `missing`, and `ok` for a completed check; `missing` includes `AI-Model` when its value is invalid. With `--require-run`, `missing` includes `AI-Run` when it is absent or malformed, including a model that differs from `AI-Model`. Without that flag, optional run data does not affect the check. Combine `--require` and `--require-run` to require it on every message.

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

The workflow fetches PR history, then checks out the base revision before running the local Action. Bootstrap the Action, both checker scripts, and their shared `scripts/parse-agent-run.mjs` dependency on the target branch before making this check required. Checker changes take effect after they reach that branch; run the tests on proposed changes before merging them. Protect the workflow and contract files with human review as well.

## Limits

Trailers and author emails are claims, not authentication or cryptographic signatures. The checker validates the model-id format and rejects placeholders; it cannot prove which model actually ran. An agent using an unmarked human identity is not detected by the default heuristic. Use require-all mode when every commit must declare provenance, and GitHub App permissions and repository rules for authorization.

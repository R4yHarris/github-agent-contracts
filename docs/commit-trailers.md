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

`scripts/check-agent-trailers.mjs` treats a message as agent-authored when:

- it already has an `AI-Agent:` trailer, or
- `--require` is set

The PR workflow checks every commit in the pull request with `--require` **off**, and fails only agent-classified messages that lack required trailers. Consumer repos that want every commit to be agent-stamped can pass `--require`.

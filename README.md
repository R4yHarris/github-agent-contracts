# github-agent-contracts

GitHub-native contracts for coding agents. **GitHub stays the repository host.** This library does not replace Git, GitHub, or an orchestrator.

Use it so Copilot, [GitHub Agentic Workflows](https://github.com/github/gh-aw), Hermes, Codex, Cursor, and similar tools share one repo-level convention:

| Contract | Where |
| --- | --- |
| Agent instructions | `AGENTS.md` |
| Copilot instructions | `.github/copilot-instructions.md` |
| Portable skills | `skills/*/SKILL.md` |
| Bot identity | `docs/github-app-agent-identity.md` |
| Provenance trailers | `docs/commit-trailers.md` + `scripts/check-agent-trailers.mjs` |
| MCP allowlist | `skills/github-mcp-allowlist/SKILL.md` |
| Safe-output Actions | `.github/workflows-src/` |

## Non-goals

- No self-hosted forge
- No new version-control object store
- No secrets in git
- No unscoped tokens in examples

## Trailer checker

```bash
node scripts/check-agent-trailers.mjs --message-file /tmp/msg.txt
node scripts/check-agent-trailers.mjs --require --message "fix typo"
node --test tests/*.test.mjs
```

Required trailers on agent-authored commits:

```
AI-Agent: copilot-coding-agent
AI-Model: unknown
```

## Publish a new empty GitHub repo

Create an empty public repository named `github-agent-contracts` on your personal Microsoft-linked GitHub account, then:

```bash
cd github-agent-contracts
git init -b main
git add .
git commit -m "feat: day-1 GitHub agent contracts"
git remote add origin git@github.com:YOUR_LOGIN/github-agent-contracts.git
git push -u origin main
```

Sign the Microsoft CLA only when you later open PRs into `microsoft/*` or `github/*`. This repo itself uses MIT and an individual contribution model.

## License

MIT. See `LICENSE`.

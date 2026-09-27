# github-agent-contracts

GitHub-native contracts for coding agents. **GitHub stays the repository host.** This library does not replace Git, GitHub, or an orchestrator.

This is community OSS for GitHub, not a GitHub replacement.

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
| PR trailer Action | `.github/actions/check-agent-trailers/action.yml` |

Humans can review the same rules agents follow, while commit trailers make claimed agent contributions inspectable. The contracts do not schedule agents or prove their identity by themselves.

## Consume the contracts

- **Copilot / VS Code:** keep [AGENTS.md](AGENTS.md) at the repository root and [.github/copilot-instructions.md](.github/copilot-instructions.md) in place. Copy selected `skills/<name>/` directories into `.github/skills/` in the consuming repository for skill discovery in supported versions.
- **gh-aw:** include the repository rules and relevant skills in the workflow's instructions. Start with the [issue clarifier source](.github/workflows-src/issue-clarifier.md); the agent is read-only and can request only an `add-comment` safe output.
- **Hermes, Codex, and other agents:** load `AGENTS.md` as repository instructions and import the selected `SKILL.md` files using that runtime's skill mechanism. Discovery paths differ by runtime; this pack does not patch those runtimes.
- **GitHub MCP:** use the [allowlist skill](skills/github-mcp-allowlist/SKILL.md) with a repository-scoped GitHub App installation token. Keep the agent's tools read-only; give approved output handlers only the capabilities they need.

Adapt the workspace-specific names in the instruction files when adopting the pack. Human approval, scoped permissions, and tool restrictions enforce boundaries; prompts alone do not.

## Use in another repo

Follow the [adoption guide](docs/adopt.md) and copy the [consumer workflow](examples/consumer-repo/.github/workflows/check-agent-trailers.yml). Reference the pinned public Action without copying scripts, or vendor the Action and both scripts together. No package registry or GitHub App credentials are needed for the trailer check.

## Non-goals

- No self-hosted forge
- No new version-control object store
- No secrets in git
- No unscoped tokens in examples

## Trailer checker

Requires Node 20+ and Git; no package installation is needed.

```bash
node scripts/check-agent-trailers.mjs --help
node scripts/check-agent-trailers.mjs --message-file path/to/message.txt --json
node scripts/check-agent-trailers.mjs --require --message "fix typo"
node --test tests/*.test.mjs
```

Agent-classified commits require these nonempty trailers after a blank line at the end of the message:

```
AI-Agent: copilot-coding-agent
AI-Model: unknown
```

The default checks messages containing `AI-Agent:` and GitHub noreply bot authors. Human privacy addresses alone do not trigger a check. For local author detection, pass `--author-email`; `--require` checks every message. Exit codes are `0` (pass), `1` (missing trailers), and `2` (usage or input error).

See the [trailer spec](docs/commit-trailers.md) for parsing rules, limitations, and the Action's `require-on-all-commits: "true"` option.

## PR workflow

The [read-only PR workflow](.github/workflows/check-agent-trailers.yml) checks every PR commit, including bot-authored commits without an `AI-Agent:` marker. It uses the [composite Action](.github/actions/check-agent-trailers/action.yml) and both checker scripts from the base revision. Missing or incomplete history fails closed.

When vendoring this check, copy the workflow, Action directory, and both `scripts/check-*.mjs` files together. Bootstrap the Action and scripts on the base branch before enabling the local workflow. No App token or other custom secret is needed for this workflow.

## Agentic workflow

Keep the issue clarifier under `.github/workflows-src/` until `gh` and the `gh-aw` extension are available. To adopt it, copy the Markdown source into `.github/workflows/issue-clarifier.md`, then run:

```bash
gh aw compile
```

Review the generated workflow and configure the chosen engine's authentication outside git before enabling it. Its source uses `permissions: read-all` and only `safe-outputs.add-comment`; it must not create branches or push. No compiled lockfile is shipped without compiler validation.

## Publish a new empty GitHub repo

From the local repository root, after creating an empty GitHub repository:

```bash
git init -b main
git add .
git commit -m "feat: day-1 GitHub agent contracts"
git remote add origin git@github.com:YOUR_LOGIN/github-agent-contracts.git
git push -u origin main
```

If this folder already has commits and an `origin`, only `git push` is needed to publish new commits. No remote changes are needed.

## License

MIT. See `LICENSE`.

# github-agent-contracts

GitHub-native contracts for attributable agent commits and PRs, distinct from human-authored work. **GitHub stays the repository host.** The control is a required PR check, a protected branch, bot authorship, and machine-checked trailers. The App is how agents authenticate to GitHub.

This is community OSS for GitHub, not a GitHub replacement.

## Enable agent identity in 3 steps

1. **[Register App from manifest](docs/app-manifest.json).** Create an App owned by you or your organization, keep it private to that account, and choose **Only select repositories** during installation.
2. **Configure and copy.** Supply `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` outside git, then copy AGENTS.md, the policy and commit skills, publisher/loader, and check Action/workflow as listed in [ONBOARDING.md](docs/ONBOARDING.md). A human installs the root capability policy. CI stores the key in the `GITHUB_APP_PRIVATE_KEY` secret.
3. **Protect and publish.** Require `check-agent-trailers`, disallow direct pushes to `main` and agent bypass, and leave merging to humans by default. After tests, policy gates, and reviewed staging, authorized agent publication ends with `node scripts/agent-pr.mjs --message "..."`; without App configuration, stop with uncommitted changes, never a human-token fallback.

The manifest is a static template, not a hosted registration button. An owner-controlled manifest callback is a follow-on; placeholder URLs must be replaced before completing GitHub's flow. The [onboarding guide](docs/ONBOARDING.md) describes that boundary and the manual registration fallback.

### Create your own App (recommended)

Your account or organization owns the App and controls its private key. No project-maintainer installation is needed. Use the [manifest](docs/app-manifest.json), [harness guide](docs/HARNESSES.md), [dedicated machine guide](docs/ORCHESTRATION-MACHINE.md), and [threat model](docs/THREAT_MODEL.md). The App key holder can mint tokens for **every installation of that App**, so installation scope and key custody matter. The manifest includes Checks read-only; humans must accept this permission on existing installations for opt-in merge.

### Demo App

`r4yharris-agent-coder` is an optional maintainer demo identity for **public playground repositories only**. Do not install it on private or production repositories or grant it protected-branch bypass. A globally shared maintainer App is not this standard's production onboarding model.

## Shared contracts

Use it so Copilot, [GitHub Agentic Workflows](https://github.com/github/gh-aw), Hermes, Codex, Cursor, and similar tools share one repo-level convention:

| Contract | Where |
| --- | --- |
| Agent instructions | `AGENTS.md` |
| Default-deny capabilities | `examples/agent-policy.yml` + `docs/POLICY.md` |
| Copilot instructions | `.github/copilot-instructions.md` |
| Portable skills | `skills/*/SKILL.md` |
| Bot identity | `docs/github-app-agent-identity.md` |
| Provenance trailers | `docs/commit-trailers.md` + `scripts/check-agent-trailers.mjs` |
| MCP allowlist | `skills/github-mcp-allowlist/SKILL.md` |
| Safe-output Actions | `.github/workflows-src/` |
| PR trailer Action | `.github/actions/check-agent-trailers/action.yml` |

Humans can review the same rules agents follow, while commit trailers make claimed agent contributions inspectable. The contracts do not schedule agents or prove their identity by themselves.

## Consume the contracts

- **Copilot / VS Code:** use [AGENTS.md](AGENTS.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md) only as harness configuration. They reference the common commit skill and publisher; no additional agent mode or skill autodiscovery setup is required.
- **Claude Code:** use the short [CLAUDE.md](CLAUDE.md) pointer to AGENTS.md, not a duplicate policy.
- **gh-aw:** include the repository rules and relevant skills in the workflow's instructions. Start with the [issue clarifier source](.github/workflows-src/issue-clarifier.md); the agent is read-only and can request only an `add-comment` safe output.
- **Hermes, Codex, and other agents:** load `AGENTS.md` as repository instructions and import the selected `SKILL.md` files using that runtime's skill mechanism. Discovery paths differ by runtime; this pack does not patch those runtimes.
- **GitHub MCP:** use the [allowlist skill](skills/github-mcp-allowlist/SKILL.md) with a repository-scoped GitHub App installation token. Keep the agent's tools read-only; give approved output handlers only the capabilities they need.

Adapt the workspace-specific names in the instruction files when adopting the pack. Human approval, scoped permissions, and tool restrictions enforce boundaries; prompts alone do not.

See [HARNESSES.md](docs/HARNESSES.md) for the minimal integration in each runtime. Any agent that honors AGENTS.md must honor signed-bot-commit.

## Use in another repo

Follow the [adoption guide](docs/adopt.md) and copy the [consumer workflow](examples/consumer-repo/.github/workflows/check-agent-trailers.yml). Reference the pinned public Action without copying scripts, or vendor the Action and both scripts together. No package registry or GitHub App credentials are needed for the trailer check.

## Capability policy

Hermes, Copilot, Claude Code, and Cursor share one human-owned root `agent-policy.yml`. The [example](examples/agent-policy.yml) allows coder branch commits, draft PRs, comments, and labels; merger and deploy allow-lists are empty. Missing policy denies publication, and agents must not edit policy to grant themselves rights.

Read [POLICY.md](docs/POLICY.md) for the three permission layers, human bootstrap, and optional `--merge-when-green` flow, and [ROLES.md](docs/ROLES.md) for role-key separation. Merging remains disabled unless a human publishes `roles.merger.allow: [merge]` and explicitly authorizes the flag; coder `merge` alone is insufficient. The flag requires a successful exact-head trailer check and all GitHub reviews, creates a merge commit, and cleans up only unchanged remote and local feature refs after confirmation. Policy does not select the App key; a coder-only WSL host must disable merge and a trusted launcher/operator must use a separately approved merger App/context. Protected pushes and deploys remain unsupported. No active policy grant or hosted control plane is installed by this pack.

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

See the [trailer spec](docs/commit-trailers.md) for parsing rules and the Action's `require-on-all-commits: "true"` option. The [threat model](docs/THREAT_MODEL.md) explains why trailers and bot fields do not prove authorship, and why unsigned human commits pass the default check.

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

These bootstrap commands are for a **human**. Agents must use the App-authenticated publication helper and never assume the human's identity.

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

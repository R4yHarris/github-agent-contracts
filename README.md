# github-agent-contracts

github-agent-contracts gives Hermes, Claude Code, GitHub Copilot, OpenClaw, Cursor, and Codex a user-owned GitHub App bot identity and a default-deny permission policy, separate from the human GitHub user.

## Give agents their own identity in 3 steps

1. **Create your own GitHub App** from [docs/app-manifest.json](docs/app-manifest.json). Your user or organization owns the App and its key; install it on selected repositories only. Follow [ONBOARDING](docs/ONBOARDING.md) for registration and the two publisher environment variables.
2. **Define repository permissions** in root `agent-policy.yml`. A human reviews and publishes the [default-deny example](examples/agent-policy.yml). Coder can commit feature branches, open draft PRs, comment, and label; merge and deploy remain denied by default. See [POLICY](docs/POLICY.md).
3. **Publish as the App bot** with `node scripts/agent-pr.mjs`. Copy the required files from the onboarding guide, review and stage the changes, pass tests and policy gates, then run the authorized publication command:

```bash
node scripts/agent-pr.mjs --message "feat: add input validation"
```

**Humans merge by default.** Opt-in merging requires a human-published `merger.merge` grant plus explicit authorization for `--merge-when-green`, successful checks on the exact head SHA, and all required reviews. Coder `merge` alone is insufficient.

This is **not a git host, not `copilot[bot]`, not a personal access token (PAT), and not a maintainer-owned App to install on other people's private repositories**. It is community OSS for GitHub, not a GitHub replacement.

[ONBOARDING](docs/ONBOARDING.md) | [POLICY](docs/POLICY.md) | [THREAT_MODEL](docs/THREAT_MODEL.md) | [HARNESSES](docs/HARNESSES.md) | [ORCHESTRATION-MACHINE](docs/ORCHESTRATION-MACHINE.md) | [AGENTS.md](AGENTS.md)

## Which approach fits?

| Approach | Identity and permissions | Role |
| --- | --- | --- |
| **This pack** | Your GitHub App bot, repository-scoped installation tokens, root capability policy, and commit trailers | A concrete identity and publishing contract shared by different agent harnesses |
| **`copilot[bot]`** | GitHub-managed bot identity for supported Copilot activity | Not a credential or user-owned App you can assign to Hermes or arbitrary agents |
| **Personal access token** | Authenticates as the GitHub user that owns the token, including a separately managed machine user | User-bound access, not an App-owned bot identity; no PAT fallback in this pack |
| **[gh-aw](https://github.com/github/gh-aw)** | GitHub Actions workflows with declared permissions and safe outputs | Agent workflow automation that can consume these contracts; not a replacement for the repository identity policy |

## What enforces the contract?

The control is **required PR check + protected branch + bot author + trailers**. The App authenticates GitHub operations. App permissions, branch protection/environments, and the policy must all allow an action; installing an App or adding a prompt does not replace these gates.

The [publisher](scripts/agent-pr.mjs) discovers the configured App's bot, sets both author and committer, appends `AI-Agent` and `AI-Model`, pushes an authorized feature branch, and creates a draft PR if none exists. It uses `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` from the environment, not a signed-in human's credentials. Missing configuration or denied policy means stop with changes uncommitted.

Humans own policy and workflow changes. Agents cannot grant themselves capabilities or publish `.github/workflows/**` through this helper. Never force-push, push main directly, squash, or self-approve. Deploy and direct protected-push implementations are out of scope.

Trailers and bot fields are claims, not cryptographic proof of who wrote the code. Git commits are currently unsigned; see the [threat model](docs/THREAT_MODEL.md) before adopting this in a repository that requires signing.

## Attach your agent

- **Hermes:** read [AGENTS.md](AGENTS.md), load [agent-policy](skills/agent-policy/SKILL.md) and [signed-bot-commit](skills/signed-bot-commit/SKILL.md), and publish only through the helper. Use the [GitHub MCP allowlist](skills/github-mcp-allowlist/SKILL.md) for scoped reads.
- **Claude Code:** start with the [CLAUDE.md](CLAUDE.md) pointer to the shared rules.
- **GitHub Copilot:** use [AGENTS.md](AGENTS.md) and [.github/copilot-instructions.md](.github/copilot-instructions.md).
- **OpenClaw, Cursor, and Codex:** load the same repository instructions and skills through your runtime's supported mechanism. This pack does not install or patch those runtimes.

See [HARNESSES](docs/HARNESSES.md) for integration details. On a dedicated WSL/Hermes machine, keep only the coder App key, no human GitHub login, and merge disabled until a separate approved merger context is available; follow [ORCHESTRATION-MACHINE](docs/ORCHESTRATION-MACHINE.md). Policy does not select or switch App keys.

## Use in another repo

Follow [ONBOARDING](docs/ONBOARDING.md) for the complete file list and [adopt.md](docs/adopt.md) for distribution options. Copy the [consumer workflow](examples/consumer-repo/.github/workflows/check-agent-trailers.yml) with a pinned public Action, or vendor the [composite Action](.github/actions/check-agent-trailers/action.yml) with both checker scripts. No private-package infrastructure or App credentials are required for the read-only trailer check itself.

The manifest is a static template, not a hosted registration button. Its placeholder callback URLs need an owner-controlled receiver for GitHub's manifest flow; onboarding also documents the manual registration path. No hosted callback or control plane is provided.

Create an App owned by the consuming user or organization. The key holder can mint tokens for **every installation of that App**. The maintainer's `r4yharris-agent-coder` demo is for public playgrounds only, never private or production repositories. See the [identity guide](docs/github-app-agent-identity.md) and [role separation](docs/ROLES.md).

## Check commit provenance

Node 20+ and Git are required; the scripts have no runtime dependencies. Publication also needs `gh`.

```bash
node scripts/check-agent-trailers.mjs --help
node scripts/check-agent-trailers.mjs --message-file path/to/message.txt --json
node --test tests/*.test.mjs
```

An agent commit has a blank-separated footer:

```text
AI-Agent: your-app-slug
AI-Model: unknown
```

The check inspects messages containing `AI-Agent:` and GitHub noreply bot authors by default. Unmarked human commits pass. `--require`, or the Action's `require-on-all-commits: "true"`, requires trailers on every commit. See the [trailer specification](docs/commit-trailers.md) for parsing, exit codes, and limits.

The [PR workflow](.github/workflows/check-agent-trailers.yml) uses the trusted base revision's checker with full history and read-only permissions. Bootstrap the Action and scripts before enabling the local workflow. Humans must configure required checks, reviews, and branch protection; the script does not configure them.

## With gh-aw

The [issue clarifier source](.github/workflows-src/issue-clarifier.md) illustrates `permissions: read-all` and a comment-only safe output. Approved output handlers must enforce the repository policy too. Keep Markdown sources uncompiled unless `gh aw` is already installed; no generated lockfile or agent runtime is required to use the identity contract.

## Find and cite this pack

[DISCOVERY.md](docs/DISCOVERY.md) lists the user questions this repository answers, harness attachment steps, suggested topics, and a citation snippet. Skill hubs can index the root [SKILL.md](SKILL.md); citation tools can use [CITATION.cff](CITATION.cff).

## License

MIT. See [LICENSE](LICENSE).

# Adopt in another repository

Choose a pinned public Action or vendor the Action and its scripts. Both options use ordinary GitHub files and Actions: no package registry, private-package infrastructure, GitHub App credentials, or custom secrets are required for the trailer check.

For the complete bot-identity standard, start with [ONBOARDING.md](ONBOARDING.md): register your own App from the manifest, configure the publisher, and protect the branch. This page covers the check's distribution options, not registration of a shared maintainer App.

## Reference the public Action

1. Review the [consumer workflow](../examples/consumer-repo/.github/workflows/check-agent-trailers.yml) and copy it to `.github/workflows/check-agent-trailers.yml` in the consuming repository. Merge with any existing workflow instead of overwriting it blindly.
2. Keep `actions/checkout` pointed at the **consumer repository** with `fetch-depth: 0` and `persist-credentials: false`. The Action needs its complete PR history, not a checkout of this pack.
3. Keep the pack's `uses:` reference pinned to a reviewed, full commit SHA. The example references `R4yHarris/github-agent-contracts` at a revision containing the Action and both scripts. Review changes before updating the pin; do not switch to a moving `main` reference for convenience.
4. Enable Actions in the consumer and ensure its Actions policy permits `actions/checkout` and the referenced public Action. After a successful PR run, a human must require the `check-agent-trailers` job in protected-branch rules for the standard to be enforced.

GitHub downloads the referenced pack revision separately from the consumer checkout. The composite Action finds its scripts relative to `github.action_path`, while the runner inspects Git history in the consumer's working directory. **This option does not require copying `scripts/` into the consumer.** It also does not install a local trailer-checking CLI there.

The example runs on `ubuntu-latest`, which supplies Node 20+, Git, and Bash. It uses `pull_request`, only `contents: read`, and no write-capable token. The pinned checker reads PR commits as data rather than executing checker code supplied by the PR. Keep human review on workflow changes; a SHA pin does not protect a workflow that someone is allowed to rewrite.

## Vendor the Action

Use this option when the consumer cannot reference the public Action or needs to maintain its own reviewed copy. Copy these files from the same pack revision, preserving their paths:

```text
.github/actions/check-agent-trailers/action.yml
scripts/check-agent-trailers.mjs
scripts/check-pr-agent-trailers.mjs
scripts/parse-agent-run.mjs
```

The source files are the [composite Action](../.github/actions/check-agent-trailers/action.yml), [message checker](../scripts/check-agent-trailers.mjs), [PR runner](../scripts/check-pr-agent-trailers.mjs), and [shared parser](../scripts/parse-agent-run.mjs). Retain the pack's [MIT notice](../LICENSE) with the vendored files without replacing the consumer's own license.

**Copying only the Action metadata is not sufficient.** Its command needs both checker scripts and their shared parser at the relative paths above. Copying instruction files or a workflow does not make a local `uses: ./.github/actions/check-agent-trailers` reference point back to this pack.

For this option, copy the pack's [local workflow](../.github/workflows/check-agent-trailers.yml), not the remotely pinned consumer example. The local workflow fetches full PR history, checks out the trusted base revision, and then runs:

```yaml
- name: Check trailers on PR commits
  uses: ./.github/actions/check-agent-trailers
  with:
    base-sha: ${{ github.event.pull_request.base.sha }}
    head-sha: ${{ github.event.pull_request.head.sha }}
```

Land the Action, both checker scripts, and the shared parser on the target branch in a reviewed bootstrap change **before enabling the local workflow**. Otherwise its first run cannot find the checker at the base revision. Keep the trusted-base checkout step when adopting the local workflow; checker updates take effect after they reach that branch.

For local validation and future updates, also copy the [message-checker tests](../tests/check-agent-trailers.test.mjs) and [PR-runner tests](../tests/check-pr-agent-trailers.test.mjs) into `tests/`. With Node 20+ and Git available, run from the consumer root:

```bash
node scripts/check-agent-trailers.mjs --help
node --test tests/*.test.mjs
```

Update the Action, scripts, and tests together from a reviewed revision. Neither adoption option needs `npm install`.

Optional v0.2.0 run metadata is described in [METRICS.md](METRICS.md). Copy [export-agent-metrics.mjs](../scripts/export-agent-metrics.mjs) for local JSONL export if needed. The shared parser remains required by the checker even when run metadata is not enabled; the default trailer policy is unchanged.

## Choose the policy

By default, every PR commit is inspected, but required trailers are enforced only when its message contains `AI-Agent:` or its author has a GitHub noreply bot address. Human privacy addresses alone do not trigger the check. See the [trailer specification](commit-trailers.md) for exact parsing and bot-address rules.

Agent-classified commits need a blank-separated footer such as:

```text
feat: add input validation

AI-Agent: copilot-coding-agent
AI-Model: unknown
```

To require trailers on human commits too, set this input in the Action step's `with:` block:

```yaml
require-on-all-commits: "true"
```

The default is `"false"`. Missing required trailers fail the check, as do invalid commit ranges or incomplete history. Trailers and author emails are provenance claims, not proof of identity or authorization to write to GitHub.

Before requiring the check, verify a PR with valid trailers passes and a marked agent commit missing `AI-Model` fails. In the default mode, an unmarked human commit should pass; in require-all mode, it should fail. Every commit in the PR must satisfy the selected policy, not just the latest commit.

## Adopt the other contracts

- Merge the relevant rules from [AGENTS.md](../AGENTS.md) and [Copilot instructions](../.github/copilot-instructions.md) into the consumer's instructions. Replace this pack's hard-coded workspace name, bootstrap exceptions, file references, and commands with the consumer's own rules. Do not overwrite existing policies.
- Copy the [commit skill](../skills/signed-bot-commit/SKILL.md) referenced by AGENTS.md and follow [HARNESSES.md](HARNESSES.md) for the minimal harness pointers. Copilot configuration is AGENTS.md plus its Copilot instructions; no additional skill-autodiscovery configuration is required. Read-only MCP allowlists and approved safe outputs still apply.
- GitHub App identity is optional for installing the trailer check alone, but required for App-authenticated agent publication. Follow the [identity guide](github-app-agent-identity.md) and manifest-first onboarding to provision a user/org-owned App, not a maintainer App for private repositories. Do not create credential files or invent credentials as part of adopting the files.
- The [issue clarifier](../.github/workflows-src/issue-clarifier.md) is optional and independent of trailer checking. Keep it as Markdown source unless `gh aw` is already available; do not handwrite compiled lockfiles or install `gh-aw` as part of this adoption procedure.
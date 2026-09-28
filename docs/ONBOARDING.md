# Enable agent identity in 3 steps

Use an App **you or your organization own**. The security control is a required PR check plus a protected branch, bot authorship, and provenance trailers. The App authenticates publication; installing it alone does not enforce that control.

## 1. Register your App

Browser entry point: **[Register App from manifest](app-manifest.json)**. Use a unique name ending in `-agent-coder`, create it under the account or organization that owns the repositories, and keep it private: **Only on this account**. On GitHub's installation screen, choose **Only select repositories**, starting with one repository.

This link is a **static template, not a working registration service**. Replace its placeholder callback with an operator-controlled receiver before submitting it through [GitHub's manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Callback hosting is a follow-on, not part of this change. Until your receiver exists, use GitHub's manual App registration form with the same settings; do not submit secrets or a conversion code to this project's maintainer.

The manifest sets `public: false`, disables webhooks and user OAuth, and requests only metadata read plus contents, issues, and pull requests write. Omit issues write if you do not need comment or label outputs. It requests no administration, secrets, workflows, or organization-member permissions. GitHub has **no manifest field to default repository selection**; selecting repositories during installation is a required human step, not something the JSON enforces.

Do not install `r4yharris-agent-coder` on private or production repositories. A maintainer demo App is optional for public playgrounds only; see [the threat model](THREAT_MODEL.md).

## 2. Configure and copy

Provide exactly two environment variables to the approved publisher:

| Variable | Value supplied by the operator |
| --- | --- |
| `GITHUB_APP_ID` | The App ID from your registration, not a bot user ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | An absolute path to the private key stored outside the repository |

No installation ID or bot name is needed. The helper discovers the installation for `origin`, verifies its App ID, and resolves that App's bot account. It does not load `.env` or use the signed-in human's token as a fallback. Never paste PEM contents, installation tokens, or client secrets into chat or tracked files.

For CI, keep the App ID in a configuration variable and the key in the **`GITHUB_APP_PRIVATE_KEY` secret**. An operator-controlled credential step must materialize it in a restricted runner-temporary file outside the checkout, set `GITHUB_APP_PRIVATE_KEY_PATH`, and remove it afterward. The helper reads the path, not the raw CI secret. Do not expose it to fork PRs or untrusted jobs. The PR trailer-check workflow needs **no App secret**.

Copy these files into the consuming repository, preserving paths and merging existing rules rather than overwriting them:

```text
AGENTS.md
skills/signed-bot-commit/SKILL.md
scripts/agent-pr.mjs
scripts/check-agent-trailers.mjs
scripts/check-pr-agent-trailers.mjs
.github/actions/check-agent-trailers/action.yml
.github/workflows/check-agent-trailers.yml
```

Use Node 20+, Git, and `gh` for publication. Adapt the workspace name and test command in the copied rules. Follow [HARNESSES.md](HARNESSES.md) for the small harness-specific pointers, and [adopt.md](adopt.md) for the pinned public-Action alternative and vendoring details. No private-package infrastructure or runtime dependency installation is needed.

For the local Action, land the Action and both checker scripts on the target branch before enabling the workflow, because it executes the base revision's trusted checker. A human bootstraps workflow changes: the App intentionally has no workflows-write permission. Keep human review on changes to the workflow, instructions, and publisher.

## 3. Protect the branch and publish

After a successful trial PR run, configure branch protection or a ruleset for `main` (and any other protected integration branch):

- Require a PR, human approval, and the **`check-agent-trailers`** check from GitHub Actions. Both supplied workflows give the job this exact name. Update existing required-check rules if adopting from an older job name.
- Disallow direct pushes, force pushes, and branch deletion. Do not give the App a bypass. Limit protected-branch updates and merges to authorized humans, using the restrictions available for your account and plan.
- Never permit agent merge or auto-merge tooling. Pull requests write permission is not inherently draft-only or merge-proof; branch rules and the human merge gate are required.

Tell the agent:

> Use signed-bot-commit / scripts/agent-pr.mjs for all publish. Never publish as the signed-in human, print tokens, or merge. Stop if App authentication is unavailable.

Authorize a specific feature-branch publication, then let the agent use the helper. Check the bot author/committer and trailers on the resulting commits. The helper creates a draft PR or reuses an existing open PR. **Humans review and merge.** Local commits do not independently authorize a push.

The current helper makes unsigned Git commits; its JWT signature authenticates the App, not the commit. See [THREAT_MODEL.md](THREAT_MODEL.md) for checker limits and repositories that require signed commits.

## Manifest flow follow-on

The future registration button needs an operator-controlled manifest receiver, not a centrally owned App:

1. POST the JSON as the `manifest` form parameter to `https://github.com/settings/apps/new`, or `https://github.com/organizations/YOUR_ORG/settings/apps/new` for an organization. Include an unpredictable `state` bound to the initiating session. The user reviews the name and creates their own App in GitHub.
2. GitHub redirects to the operator's `redirect_url` with a short-lived code. Validate `state` and keep the code out of logs and chat.
3. Within one hour, the operator's trusted service exchanges it at `POST /app-manifests/{code}/conversions`. The response contains the App ID and sensitive material, including the PEM and client secret. Deliver needed material only to the owner's secret store; never return or log it in public pages. Client secrets are not used by this publisher.

The `example.invalid` callback and disabled-webhook URLs are deliberately nonfunctional placeholders. This repository ships no callback handler, hosted registration endpoint, secret storage, or client-secret management. Anyone operating the callback can see generated key material, so App ownership alone is insufficient if an untrusted service handles registration.
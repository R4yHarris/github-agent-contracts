# Dedicated orchestration machine

A dedicated WSL/Hermes (or similar) environment runs agent work without a signed-in human GitHub identity. Keep the Windows host's human identities on Windows; these instructions do not log out or reconfigure Windows.

## Credential boundary

- Give the WSL publisher only `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` for the user/org-owned **coder** App. Keep the coder key outside the checkout and expose it only to an approved publication context. Do not put key contents or tokens in scripts, files tracked by git, chat, or logs.
- Do not mount or forward human SSH agents/keys, human GitHub tokens, Windows `gh` authentication, or merger/deploy keys into WSL. Do not use human-token environment fallbacks or a human Git credential helper there.
- Keep `--merge-when-green` disabled on the coder-only machine. A human-published `merger.merge` grant is a policy gate, not proof of which App key the helper uses. A trusted launcher/operator must arrange a separately approved merger App/context for any authorized merge; the helper does not switch keys or accept a role override.
- Missing App configuration, denied policy, or an instruction to stop after testing means leave changes uncommitted. No human identity is a fallback.

## Remove WSL human sign-in

In the **WSL Linux shell only**, an operator can inspect `gh auth status`, then log out any human account previously signed in there:

```bash
gh auth logout --hostname github.com --user HUMAN_LOGIN
```

Replace `HUMAN_LOGIN` with the human account shown in WSL. The operator runs this command, not the agent. Remove other human SSH forwarding and token injection from the WSL launch configuration as well. Do not run a global logout on Windows; the Windows host retains the operator's identities.

## Publication boundary

After reviewing and staging intended files, passing tests and policy checks, and receiving explicit authorization for commit, push, and a draft PR, publication is the final implementation step:

```bash
node scripts/agent-pr.mjs --message "docs: clarify agent contracts"
```

The helper uses the configured App, not the signed-in human. It refuses staged or selected `.github/workflows/**` paths before token minting; a human publishes workflow changes. See [ONBOARDING.md](ONBOARDING.md), [POLICY.md](POLICY.md), and [ROLES.md](ROLES.md) for installation scope, grants, and required GitHub protections. No machine configuration is performed by this document.
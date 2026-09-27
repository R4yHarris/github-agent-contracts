# Security

## Do not report secrets in public issues

If you find a credential in this repository or a consumer workflow, rotate it first, then open a private advisory if the GitHub repo has advisories enabled, or email the maintainer listed on the GitHub profile.

## Design rules

- Examples must not include live tokens.
- GitHub App private keys never land in git.
- MCP examples use tool allowlists.
- Agentic workflows default to read-only plus documented safe-outputs.
- This project does not execute untrusted repos’ `core.fsmonitor` hooks; document `git -c core.fsmonitor=false` when cloning unknown code.

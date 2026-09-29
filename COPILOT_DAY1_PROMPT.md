# Paste this into GitHub Copilot Chat in VS Code

Use **Agent** mode. Open this folder as the workspace root. Do not access any other repository.

---

You are implementing **github-agent-contracts**, a new public MIT library of GitHub-native contracts for coding agents (Copilot, gh-aw, Hermes, Codex, and others). GitHub remains the forge. This repo is not a version-control server.

## Absolute constraints

1. Create and edit files **only** under the current workspace.
2. Do not `cd` to sibling projects. Do not change git remotes except `origin` for *this* repo if the user already created it on GitHub.
3. Do not write secrets. No PATs, Copilot tokens, PEM keys, or `.env` files with values.
4. Do not add npm/pip runtime dependencies. Scripts are Node 20 ESM with zero dependencies.
5. Do not implement a git forge, object database, SPIFFE stack, or orchestrator.
6. Follow `AGENTS.md` and `docs/DAY1_SCOPE.md` if they exist; if something contradicts this prompt, prefer the narrower scope.

## Goal for this session

Finish the Day-1 checklist in `docs/DAY1_SCOPE.md` so a clone of this repo is usable:

- Humans and agents read the same rules.
- Agent-authored commits can be recognized via trailers.
- A PR Action fails closed if required trailers are missing on commits that claim to be agent-authored *or* when the workflow is run with `require-on-all-commits: true` only if documented — default: check commits whose message already contains `AI-Agent:` OR whose author email matches `*noreply.github.com` bot pattern. Also provide `--require` flag for local use.
- Skills and one gh-aw source workflow are copy-pasteable.

## Implementation notes

### Trailer checker

Required trailers when a commit is classified as agent-authored:

```
AI-Agent: <name>
AI-Model: <actual model id; do not invent or use "unknown">
```

Recommended:

```
AI-Session: <opaque id>
Co-authored-by: <human owner name> <email>
```

Implement `scripts/check-agent-trailers.mjs`:

- CLI: `--message`, `--message-file`, `--require` (treat every message as agent-authored), `--json`
- Exit 0 if OK, 1 if missing required trailers, 2 on usage errors
- Parse trailers as `Key: value` lines after the first blank line of the commit message (git trailer convention)
- Include `--help`

Tests in `tests/check-agent-trailers.test.mjs` using `node --test`. Cover: valid agent message, missing AI-Agent, human message without `--require` passes, human message with `--require` fails.

### GitHub Action

`.github/workflows/check-agent-trailers.yml`:

- `on: pull_request`
- checkout
- `git log --format=%B -n 1 ${{ github.event.pull_request.head.sha }}` or iterate commits in the PR
- run the checker on each commit message
- permissions: `contents: read`

Keep the Action local to this repo for day 1 (`uses: ./` composite is optional; an inline workflow is enough).

### Docs to write if missing

Fill `README.md` with:

- What / why / non-goals
- How Copilot, gh-aw, and Hermes consume `AGENTS.md`, skills, and GitHub MCP
- How to use the trailer checker
- “This is community OSS for GitHub, not a GitHub replacement”

Fill identity + trailer docs from the outlines already in `docs/` if present; otherwise create them briefly.

### gh-aw source

`.github/workflows-src/issue-clarifier.md` frontmatter:

```yaml
on:
  issues:
    types: [opened]
permissions: read-all
safe-outputs:
  add-comment:
```

Markdown body: ask clarifying questions when an issue lacks repro steps or acceptance criteria. Do not create branches or push.

### When you are done

1. Run `node --test tests/*.test.mjs` and fix failures.
2. List files created.
3. Print a short “how the human publishes this to a new empty GitHub repo” (git init / remote / push) — commands only, no extra products.

Work in small commits if git is already initialized; otherwise just write the files.

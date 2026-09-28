#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createPrivateKey, KeyObject, sign } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { checkMessage } from "./check-agent-trailers.mjs";
import { AgentPolicyError, loadAgentPolicy, parseAgentPolicy, requireCapability } from "./load-agent-policy.mjs";

class AgentPrError extends Error {}

export function createAppJwt(appId, privateKey, now = Date.now()) {
  if (!/^[1-9][0-9]*$/.test(String(appId))) {
    throw new AgentPrError("GITHUB_APP_ID must be a numeric App ID.");
  }
  try {
    const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
    if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
      throw new Error("RSA private key required");
    }
    const seconds = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: String(appId),
    })).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
  } catch {
    throw new AgentPrError("Could not sign the App JWT; check the private key outside chat.");
  }
}

async function githubRequest(path, token, { method = "GET", body, fetchImpl = globalThis.fetch, allowMissing = false } = {}) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "github-agent-contracts",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AgentPrError("GitHub API request failed; check connectivity and authentication.");
  }
  if (allowMissing && response.status === 404) return undefined;
  if (!response.ok) {
    throw new AgentPrError(`GitHub API request failed (HTTP ${Number(response.status)}).`);
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new AgentPrError("GitHub returned an invalid JSON response.");
  }
}

export async function mintInstallationToken(
  { appId, privateKey, owner, repository, readChecks = false },
  { fetchImpl = globalThis.fetch, now = Date.now() } = {},
) {
  const jwt = createAppJwt(appId, privateKey, now);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const installation = await githubRequest(`${repoPath}/installation`, jwt, { fetchImpl });
  if (
    !Number.isSafeInteger(installation?.id) || installation.id <= 0 ||
    String(installation.app_id) !== String(appId) ||
    typeof installation.app_slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(installation.app_slug) ||
    installation.suspended_at
  ) {
    throw new AgentPrError("The repository needs an active installation matching GITHUB_APP_ID.");
  }
  const permissions = { contents: "write", pull_requests: "write" };
  if (readChecks) permissions.checks = "read";
  const access = await githubRequest(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: { repositories: [repository], permissions },
    fetchImpl,
  });
  if (
    typeof access?.token !== "string" || !access.token || /\s/.test(access.token) ||
    !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= now
  ) {
    throw new AgentPrError("GitHub did not return a valid, unexpired installation token.");
  }
  return { token: access.token, appSlug: installation.app_slug };
}

export function parseOrigin(origin) {
  let url;
  try {
    url = new URL(origin.startsWith("git@github.com:")
      ? `ssh://git@github.com/${origin.slice("git@github.com:".length)}`
      : origin);
  } catch {
    throw new AgentPrError("origin must be a GitHub HTTPS or SSH repository URL.");
  }
  if (
    url.hostname !== "github.com" || !["https:", "ssh:"].includes(url.protocol) ||
    url.password || url.port || url.search || url.hash ||
    (url.protocol === "https:" ? url.username : url.username !== "git")
  ) {
    throw new AgentPrError("origin must use github.com without embedded credentials.");
  }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname);
  if (!match || [".", ".."].includes(match[2])) {
    throw new AgentPrError("origin must identify exactly one GitHub owner and repository.");
  }
  return { owner: match[1], repository: match[2] };
}

function validateCommitInput(message, model = "unknown") {
  if (typeof message !== "string" || !message.trim() || message.includes("\0")) {
    throw new AgentPrError("Provide a nonempty commit message with --message.");
  }
  if (typeof model !== "string" || !model.trim() || /[\r\n\0]/.test(model)) {
    throw new AgentPrError("--model must be a nonempty single-line value.");
  }
}

export function buildCommitMessage(message, model = "unknown", appSlug) {
  validateCommitInput(message, model);
  if (typeof appSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(appSlug)) {
    throw new AgentPrError("A verified App slug is required for the AI-Agent trailer.");
  }
  return `${message.replace(/\r\n/g, "\n").trim()}\n\nAI-Agent: ${appSlug}\nAI-Model: ${model.trim()}\n`;
}

export function parseArgs(argv) {
  const options = { model: "unknown", files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--merge-when-green") {
      options.mergeWhenGreen = true;
    } else if (argument === "--files") {
      options.files = argv.slice(index + 1);
      if (!options.files.length || options.files.some((file) => file.startsWith("--"))) {
        throw new AgentPrError("--files must be last and followed by literal file paths.");
      }
      break;
    } else if (argument === "--message" || argument === "-m" || argument === "--model") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new AgentPrError("--message and --model each need a value.");
      }
      options[argument === "--model" ? "model" : "message"] = value;
    } else if (["--merge", "--push-protected", "--push_protected", "--deploy"].includes(argument)) {
      throw new AgentPrError("Use --merge-when-green only with an approved merger merge grant. Protected pushes and deploys are unsupported.");
    } else {
      throw new AgentPrError("Unknown argument; use --help for usage.");
    }
  }
  if (!options.help) validateCommitInput(options.message, options.model);
  return options;
}

function safeFile(file, cwd, privateKeyPath) {
  if (typeof file !== "string" || !file || file.includes("\0")) {
    throw new AgentPrError("Only literal repository file paths may be committed.");
  }
  const absolute = resolve(cwd, file);
  const local = relative(cwd, absolute).split(sep).join("/");
  const parts = local.toLowerCase().split("/");
  const name = parts.at(-1);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith("../") || parts.includes(".git")) {
    throw new AgentPrError("Files must stay inside this repository and outside .git.");
  }
  if (
    (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) ||
    /\.(pem|key|p12|pfx)$/i.test(name) || relative(absolute, privateKeyPath) === ""
  ) {
    throw new AgentPrError("Refusing to commit an environment file or private-key path.");
  }
  return local;
}

function commandEnvironment(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(GIT_|GH_|GITHUB_APP_)/i.test(name) &&
    !/^(GITHUB_TOKEN|GITHUB_ENTERPRISE_TOKEN|SSH_ASKPASS|NODE_OPTIONS)$/i.test(name)
  ));
  return { ...clean, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" };
}

function runCommand(command, args, options) {
  return execFileSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function readReviewedPolicy(repoPath, defaultBranch, token, fetchImpl) {
  const file = await githubRequest(`${repoPath}/contents/agent-policy.yml?ref=${encodeURIComponent(defaultBranch)}`, token, { fetchImpl });
  if (file?.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 100_000) {
    throw new AgentPrError("Cannot verify agent-policy.yml on the default branch; refusing publication.");
  }
  return parseAgentPolicy(Buffer.from(file.content, "base64").toString("utf8"));
}

async function waitForGreenPullRequest({
  repoPath, slug, branch, defaultBranch, headSha, pullNumber, token,
  fetchImpl, invoke, baseEnv, checkMergePolicy, wait, clock,
}) {
  const deadline = clock() + 600_000;
  let markedReady = false;
  for (let attempt = 0; attempt < 120 && clock() < deadline; attempt += 1) {
    await checkMergePolicy();
    const pull = await githubRequest(`${repoPath}/pulls/${pullNumber}`, token, { fetchImpl });
    if (
      pull?.number !== pullNumber || pull.state !== "open" || pull.merged !== false || typeof pull.draft !== "boolean" ||
      pull.head?.sha !== headSha || pull.head.ref !== branch || pull.head.repo?.full_name?.toLowerCase() !== slug.toLowerCase() ||
      pull.base?.ref !== defaultBranch || pull.base.repo?.full_name?.toLowerCase() !== slug.toLowerCase()
    ) {
      throw new AgentPrError("The open PR no longer matches the published head SHA, branch, and repository; refusing to merge.");
    }
    const checks = await githubRequest(`${repoPath}/commits/${headSha}/check-runs?check_name=check-agent-trailers&filter=latest&per_page=100`, token, { fetchImpl });
    if (!Array.isArray(checks?.check_runs) || checks.total_count !== checks.check_runs.length || checks.total_count > 100) {
      throw new AgentPrError("Cannot verify the complete check-agent-trailers results; refusing to merge.");
    }
    let green = checks.check_runs.length > 0;
    for (const check of checks.check_runs) {
      if (check?.name !== "check-agent-trailers" || check.head_sha !== headSha || check.app?.slug !== "github-actions") {
        throw new AgentPrError("check-agent-trailers must be a GitHub Actions check on the exact published head SHA.");
      }
      if (check.status === "completed") {
        if (check.conclusion !== "success") {
          throw new AgentPrError("check-agent-trailers did not succeed on the head SHA; no merge was attempted.");
        }
      } else if (["queued", "in_progress", "waiting", "requested", "pending"].includes(check.status)) {
        green = false;
      } else {
        throw new AgentPrError("check-agent-trailers returned an unrecognized status; refusing to merge.");
      }
    }
    if (green) {
      if (pull.draft && !markedReady) {
        invoke("gh", ["pr", "ready", String(pullNumber), "--repo", slug], "Marking draft PR ready", { env: { ...baseEnv, GH_TOKEN: token } });
        markedReady = true;
        continue;
      }
      if (!pull.draft && pull.mergeable === true && pull.mergeable_state === "clean") return;
      if (pull.mergeable === false || pull.mergeable_state === "dirty") {
        throw new AgentPrError("The PR is not mergeable; resolve conflicts without bypassing repository rules.");
      }
    }
    if (attempt < 119) await wait(5_000);
  }
  throw new AgentPrError("Timed out waiting for successful head-SHA checks and repository merge requirements; the PR and branch were left in place.");
}

export async function publishAgentPr(options, {
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  readPrivateKey = (path) => readFileSync(path),
  loadPolicy = loadAgentPolicy,
  run = runCommand,
  wait = delay,
  clock = Date.now,
  now = Date.now(),
} = {}) {
  const policy = loadPolicy({ cwd });
  requireCapability(policy, "coder", "commit_branch");
  requireCapability(policy, "coder", "open_pr");
  if (options.mergeWhenGreen) requireCapability(policy, "merger", "merge");
  validateCommitInput(options.message, options.model);
  const appId = env.GITHUB_APP_ID;
  if (!appId || !/^[1-9][0-9]*$/.test(appId) || !env.GITHUB_APP_PRIVATE_KEY_PATH) {
    throw new AgentPrError("Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH in the environment; never paste the key into chat.");
  }
  const privateKeyPath = resolve(cwd, env.GITHUB_APP_PRIVATE_KEY_PATH);
  const baseEnv = commandEnvironment(env);
  const invoke = (command, args, operation, extra = {}) => {
    try {
      return run(command, args, { cwd, env: baseEnv, ...extra });
    } catch {
      throw new AgentPrError(`${operation} failed; command output was withheld to protect credentials.`);
    }
  };
  const git = (args, operation, extra) => invoke("git", args, operation, extra);
  const root = git(["rev-parse", "--show-toplevel"], "Repository lookup").trim();
  if (relative(root, cwd) !== "") throw new AgentPrError("Run agent-pr.mjs from the repository root.");
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], "Current branch lookup").trim();
  if (!branch || ["main", "master"].includes(branch)) {
    throw new AgentPrError("Use a feature branch, not main, master, or a detached HEAD.");
  }
  const checkBranch = () => {
    if (git(["symbolic-ref", "--quiet", "--short", "HEAD"], "Current branch verification").trim() !== branch) {
      throw new AgentPrError("The current branch changed during publication; refusing to continue.");
    }
  };
  const origin = parseOrigin(git(["remote", "get-url", "origin"], "origin lookup").trim());
  const pushOrigins = git(["remote", "get-url", "--push", "--all", "origin"], "origin push URL lookup").trim().split(/\r?\n/);
  if (pushOrigins.length !== 1 || JSON.stringify(parseOrigin(pushOrigins[0])) !== JSON.stringify(origin)) {
    throw new AgentPrError("origin must fetch from and push to the same single GitHub repository.");
  }
  const slug = `${origin.owner}/${origin.repository}`;
  const pushUrl = `https://github.com/${slug}.git`;
  const gitConfig = git(["config", "--null", "--list"], "Git transport configuration lookup");
  for (const entry of gitConfig.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const name = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (/^url\..*\.(?:insteadof|pushinsteadof)$/i.test(name) && value && pushUrl.startsWith(value)) {
      throw new AgentPrError("A Git URL rewrite would change the authenticated push destination; refusing publication.");
    }
  }
  invoke("gh", ["--version"], "GitHub CLI availability check");
  const readStaged = () => git(["diff", "--cached", "--name-only", "--no-renames", "-z"], "Staged-file lookup").split("\0").filter(Boolean);
  const rejectHumanOwnedChanges = (changes) => {
    if (changes.some((file) => file.toLowerCase() === "agent-policy.yml")) {
      throw new AgentPrError("Agents cannot publish changes to root agent-policy.yml; a human must review and publish policy changes.");
    }
    if (changes.some((file) => file.replaceAll("\\", "/").toLowerCase().startsWith(".github/workflows/"))) {
      throw new AgentPrError("A human must publish changes under .github/workflows/; the coder App does not request Workflows permission.");
    }
  };
  const checkIndex = () => {
    const indexed = git(["ls-files", "--cached", "-z"], "Index lookup").split("\0").filter(Boolean);
    for (const file of indexed) safeFile(file, cwd, privateKeyPath);
  };
  const files = [...new Set((options.files ?? []).map((file) => safeFile(file, cwd, privateKeyPath)))];
  rejectHumanOwnedChanges(files);
  for (const file of files) {
    try {
      if (lstatSync(resolve(cwd, file)).isDirectory()) {
        throw new AgentPrError("--files accepts individual files, not directories.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new AgentPrError("--files accepts readable individual file paths, not directories.");
      }
    }
  }
  const staged = readStaged();
  rejectHumanOwnedChanges(staged);
  checkIndex();
  for (const file of staged) safeFile(file, cwd, privateKeyPath);
  if (files.length && staged.some((file) => !files.includes(file))) {
    throw new AgentPrError("Unrelated files are already staged; unstage them or omit --files to use the reviewed index.");
  }
  if (!files.length && !staged.length) throw new AgentPrError("Stage reviewed changes or supply --files before publishing.");

  let key;
  let token;
  let appSlug;
  try {
    try {
      key = readPrivateKey(privateKeyPath);
    } catch {
      throw new AgentPrError("Could not load the App private key from GITHUB_APP_PRIVATE_KEY_PATH.");
    }
    ({ token, appSlug } = await mintInstallationToken({ ...origin, appId, privateKey: key, readChecks: options.mergeWhenGreen === true }, { fetchImpl, now }));
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
    key = undefined;
  }

  const repoPath = `/repos/${encodeURIComponent(origin.owner)}/${encodeURIComponent(origin.repository)}`;
  let result;
  let failure;
  let committed = false;
  let merged = false;
  try {
    const botName = `${appSlug}[bot]`;
    const bot = await githubRequest(`/users/${encodeURIComponent(botName)}`, token, { fetchImpl });
    if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.login !== botName || bot.type !== "Bot") {
      throw new AgentPrError("GitHub did not return the bot identity for the configured App; refusing to publish.");
    }
    const botEmail = `${bot.id}+${botName}@users.noreply.github.com`;
    const message = buildCommitMessage(options.message, options.model, appSlug);
    const repository = await githubRequest(repoPath, token, { fetchImpl });
    if (
      repository?.full_name?.toLowerCase() !== slug.toLowerCase() ||
      typeof repository.default_branch !== "string" || !repository.default_branch || repository.archived
    ) {
      throw new AgentPrError("GitHub did not return an active repository matching origin.");
    }
    if (branch === repository.default_branch) throw new AgentPrError("Refusing to publish directly to the default branch.");
    const approvedPolicy = await readReviewedPolicy(repoPath, repository.default_branch, token, fetchImpl);
    requireCapability(approvedPolicy, "coder", "commit_branch");
    requireCapability(approvedPolicy, "coder", "open_pr");
    if (options.mergeWhenGreen) requireCapability(approvedPolicy, "merger", "merge");
    const verifyApprovedPolicy = (candidate) => {
      for (const role of Object.keys(approvedPolicy.roles)) {
        const approved = approvedPolicy.roles[role].allow;
        const actual = candidate.roles[role].allow;
        if (actual.length !== approved.length || actual.some((capability) => !approved.includes(capability))) {
          throw new AgentPrError("agent-policy.yml differs from the default branch's reviewed policy; refusing publication.");
        }
      }
    };
    verifyApprovedPolicy(policy);
    const checkProtectedBranch = async () => {
      const rules = await githubRequest(`${repoPath}/rules/branches/${encodeURIComponent(branch)}`, token, { fetchImpl });
      const remoteBranch = await githubRequest(`${repoPath}/branches/${encodeURIComponent(branch)}`, token, { fetchImpl, allowMissing: true });
      if (!Array.isArray(rules) || (remoteBranch !== undefined && (remoteBranch?.name !== branch || typeof remoteBranch.protected !== "boolean"))) {
        throw new AgentPrError("Cannot verify branch protection; refusing publication.");
      }
      if (rules.length || remoteBranch?.protected) {
        requireCapability(approvedPolicy, "coder", "push_protected");
        throw new AgentPrError("Protected-branch publication is unsupported by the coder helper, even with a policy grant.");
      }
    };
    await checkProtectedBranch();
    checkBranch();
    if (files.length) {
      git(["add", "--", ...files], "Staging selected files", { env: { ...baseEnv, GIT_LITERAL_PATHSPECS: "1" } });
    }
    const selected = readStaged();
    rejectHumanOwnedChanges(selected);
    checkIndex();
    for (const file of selected) safeFile(file, cwd, privateKeyPath);
    if (!selected.length || (files.length && selected.some((file) => !files.includes(file)))) {
      throw new AgentPrError("The staged changes are empty or no longer match the selected files.");
    }
    git(["-c", `user.name=${botName}`, "-c", `user.email=${botEmail}`, "-c", "commit.gpgsign=false", "commit", "--file=-"], "Bot commit", {
      input: message,
      env: {
        ...baseEnv,
        GIT_AUTHOR_NAME: botName,
        GIT_AUTHOR_EMAIL: botEmail,
        GIT_COMMITTER_NAME: botName,
        GIT_COMMITTER_EMAIL: botEmail,
      },
    });
    committed = true;
    const actual = git(["log", "-1", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B"], "Committed identity verification").split("\0");
    const checked = checkMessage(actual[5] ?? "", true);
    if (
      !/^[0-9a-f]{40}$/i.test(actual[0]) || actual[1] !== botName || actual[2] !== botEmail ||
      actual[3] !== botName || actual[4] !== botEmail || !checked.ok ||
      checked.trailers["AI-Agent"] !== appSlug || checked.trailers["AI-Model"] !== (options.model ?? "unknown").trim()
    ) {
      throw new AgentPrError("The new commit does not have the required bot identity and trailers; refusing to push.");
    }
    const committedFiles = git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], "Committed file verification").split("\0").filter(Boolean);
    for (const file of committedFiles) safeFile(file, cwd, privateKeyPath);
    rejectHumanOwnedChanges(git(["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", actual[0]], "Committed human-owned file verification").split("\0").filter(Boolean));
    verifyApprovedPolicy(parseAgentPolicy(git(["show", `${actual[0]}:agent-policy.yml`], "Committed policy verification")));
    await checkProtectedBranch();
    checkBranch();
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const authenticatedEnv = {
      ...baseEnv,
      GIT_CONFIG_COUNT: "8",
      GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.askPass", GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.extraHeader", GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: `http.${pushUrl}.extraHeader`, GIT_CONFIG_VALUE_3: "",
      GIT_CONFIG_KEY_4: `http.${pushUrl}.extraHeader`, GIT_CONFIG_VALUE_4: header,
      GIT_CONFIG_KEY_5: "http.followRedirects", GIT_CONFIG_VALUE_5: "false",
      GIT_CONFIG_KEY_6: "protocol.allow", GIT_CONFIG_VALUE_6: "never",
      GIT_CONFIG_KEY_7: "protocol.https.allow", GIT_CONFIG_VALUE_7: "always",
    };
    git(["push", "--no-follow-tags", pushUrl, `${actual[0]}:refs/heads/${branch}`], "Branch push", { env: authenticatedEnv });
    const pullRequestPath = `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${origin.owner}:${branch}`)}`;
    const pullRequests = await githubRequest(pullRequestPath, token, { fetchImpl });
    if (!Array.isArray(pullRequests)) throw new AgentPrError("GitHub returned an invalid pull-request list.");
    if (!pullRequests.length) {
      const subject = message.split("\n")[0];
      const title = /^\[[^\]]+\] /.test(subject) ? subject : `[agent] ${subject.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "")}`;
      invoke("gh", [
        "pr", "create", "--repo", slug, "--head", branch, "--base", repository.default_branch,
        "--draft", "--title", title, "--body", message,
      ], "Draft pull-request creation", { env: { ...baseEnv, GH_TOKEN: token } });
    }
    result = { commit: actual[0], botName, createdPullRequest: !pullRequests.length };
    if (options.mergeWhenGreen) {
      const candidates = pullRequests.length ? pullRequests : await githubRequest(pullRequestPath, token, { fetchImpl });
      if (!Array.isArray(candidates) || candidates.length !== 1 || !Number.isSafeInteger(candidates[0]?.number) || candidates[0].number <= 0) {
        throw new AgentPrError("Expected exactly one open PR for the published feature branch; refusing to merge.");
      }
      const pullNumber = candidates[0].number;
      const checkMergePolicy = async () => {
        const currentPolicy = loadPolicy({ cwd });
        requireCapability(currentPolicy, "merger", "merge");
        verifyApprovedPolicy(currentPolicy);
        const currentReviewedPolicy = await readReviewedPolicy(repoPath, repository.default_branch, token, fetchImpl);
        requireCapability(currentReviewedPolicy, "merger", "merge");
        verifyApprovedPolicy(currentReviewedPolicy);
      };
      await waitForGreenPullRequest({
        repoPath, slug, branch, defaultBranch: repository.default_branch, headSha: actual[0], pullNumber, token,
        fetchImpl, invoke, baseEnv, checkMergePolicy, wait, clock,
      });
      await checkMergePolicy();
      const mergeResult = await githubRequest(`${repoPath}/pulls/${pullNumber}/merge`, token, {
        method: "PUT", body: { sha: actual[0], merge_method: "merge", commit_message: message }, fetchImpl,
      });
      if (mergeResult?.merged !== true || !/^[0-9a-f]{40}$/i.test(mergeResult.sha)) {
        throw new AgentPrError("GitHub did not confirm a successful merge; the feature branch was not deleted.");
      }
      merged = true;
      result = { ...result, merged: true, pullRequest: pullNumber, mergeCommit: mergeResult.sha, remoteBranchDeleted: false };
      await checkProtectedBranch();
      const reference = await githubRequest(`${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`, token, { fetchImpl, allowMissing: true });
      if (reference !== undefined) {
        if (reference?.ref !== `refs/heads/${branch}` || reference.object?.type !== "commit" || reference.object.sha !== actual[0]) {
          throw new AgentPrError("The remote feature branch changed after merging; it was not deleted.");
        }
        await githubRequest(`${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: "DELETE", fetchImpl });
      }
      result = { ...result, remoteBranchDeleted: true };
      const checkLocalCleanup = (expectedBranch) => {
        if (git(["symbolic-ref", "--quiet", "--short", "HEAD"], "Local branch verification").trim() !== expectedBranch ||
            git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], "Feature branch verification").trim() !== actual[0]) {
          throw new AgentPrError("The local branch or published feature SHA changed; local cleanup was stopped.");
        }
        if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], "Worktree cleanliness verification")) {
          throw new AgentPrError("The worktree has staged, unstaged, or untracked changes; local cleanup was stopped.");
        }
      };
      checkLocalCleanup(branch);
      git(["fetch", "--no-tags", pushUrl, `refs/heads/${repository.default_branch}:refs/remotes/origin/${repository.default_branch}`], "Default branch fetch", { env: authenticatedEnv });
      checkLocalCleanup(branch);
      git(["switch", "--", repository.default_branch], "Default branch checkout");
      checkLocalCleanup(repository.default_branch);
      git(["merge", "--ff-only", `refs/remotes/origin/${repository.default_branch}`], "Default branch fast-forward");
      checkLocalCleanup(repository.default_branch);
      git(["merge-base", "--is-ancestor", actual[0], "HEAD"], "Merged feature ancestry verification");
      git(["update-ref", "-d", `refs/heads/${branch}`, actual[0]], "Local feature branch deletion");
      result = { ...result, localBranchDeleted: true, checkedOutBranch: repository.default_branch };
    }
  } catch (error) {
    const detail = error instanceof AgentPrError || error instanceof AgentPolicyError ? error.message : "Publication failed; details were withheld to protect credentials.";
    const state = merged
      ? ` PR #${result.pullRequest} was merged; ${result.remoteBranchDeleted ? "the remote feature branch was removed, but local cleanup is incomplete." : "remote-branch cleanup may be incomplete."} Inspect the branch state before retrying.`
      : committed ? " The local commit remains; do not create a duplicate commit to retry." : "";
    failure = new AgentPrError(`${detail}${state}`);
  } finally {
    try {
      await githubRequest("/installation/token", token, { method: "DELETE", fetchImpl });
    } catch {
      failure = new AgentPrError(`${failure?.message ?? "Publication completed."} Token revocation failed; it will expire automatically.`);
    }
    token = undefined;
  }
  if (failure) throw failure;
  return result;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof AgentPrError ? error.message : "Invalid arguments."}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`Usage: node scripts/agent-pr.mjs --message TEXT [--model NAME] [--merge-when-green] [--files PATH ...]

Without --files, commits the reviewed staged changes. --files must be last.
Requires Node 20+, Git, gh, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY_PATH.
Requires root agent-policy.yml with coder commit_branch and open_pr grants,
matching the reviewed policy on origin's default branch. No example fallback.
Discovers your configured App's bot identity, pushes the current feature branch to origin,
and creates a draft PR only when no open PR exists. Never force-pushes or pushes main.
--merge-when-green additionally requires merger.merge in local and reviewed policy,
plus App Checks read permission. Waits for a successful check-agent-trailers on the
exact head SHA, marks drafts ready, merges with a merge commit, then deletes that branch.
After remote deletion it fetches origin with the App token, fast-forwards the local
default branch, and deletes the unchanged local feature branch only if clean.
No self-approval, squash, role/policy override, protected push, deploy, or auto-merge mode.
An invocation authorizes commit, push, and PR creation. Keep secrets out of arguments.
`);
    return 0;
  }
  try {
    const result = await publishAgentPr(options, dependencies);
    stdout.write(`Committed ${result.commit.slice(0, 7)} as ${result.botName} and pushed to origin.\n`);
    stdout.write(result.createdPullRequest ? "Created a draft pull request.\n" : "Updated the branch for its existing pull request.\n");
    if (result.merged) stdout.write(`Merged PR #${result.pullRequest} with a merge commit, removed its remote and local feature branches, and checked out ${result.checkedOutBranch}.\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof AgentPrError || error instanceof AgentPolicyError ? error.message : "agent-pr failed; details were withheld to protect credentials."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
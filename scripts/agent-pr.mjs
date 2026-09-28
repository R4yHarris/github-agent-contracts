#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createPrivateKey, KeyObject, sign } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { checkMessage } from "./check-agent-trailers.mjs";

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

async function githubRequest(path, token, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
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
  { appId, privateKey, owner, repository },
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
  const access = await githubRequest(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: { repositories: [repository], permissions: { contents: "write", pull_requests: "write" } },
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

export async function publishAgentPr(options, {
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  readPrivateKey = (path) => readFileSync(path),
  run = runCommand,
  now = Date.now(),
} = {}) {
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
  const checkIndex = () => {
    const indexed = git(["ls-files", "--cached", "-z"], "Index lookup").split("\0").filter(Boolean);
    for (const file of indexed) safeFile(file, cwd, privateKeyPath);
  };
  const files = [...new Set((options.files ?? []).map((file) => safeFile(file, cwd, privateKeyPath)))];
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
    ({ token, appSlug } = await mintInstallationToken({ ...origin, appId, privateKey: key }, { fetchImpl, now }));
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
    key = undefined;
  }

  const repoPath = `/repos/${encodeURIComponent(origin.owner)}/${encodeURIComponent(origin.repository)}`;
  let result;
  let failure;
  let committed = false;
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
    checkBranch();
    if (files.length) {
      git(["add", "--", ...files], "Staging selected files", { env: { ...baseEnv, GIT_LITERAL_PATHSPECS: "1" } });
    }
    const selected = readStaged();
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
    checkBranch();
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    git(["push", "--no-follow-tags", pushUrl, `${actual[0]}:refs/heads/${branch}`], "Branch push", {
      env: {
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
      },
    });
    const pullRequests = await githubRequest(`${repoPath}/pulls?state=open&head=${encodeURIComponent(`${origin.owner}:${branch}`)}`, token, { fetchImpl });
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
  } catch (error) {
    const detail = error instanceof AgentPrError ? error.message : "Publication failed; details were withheld to protect credentials.";
    failure = new AgentPrError(`${detail}${committed ? " The local commit remains; do not create a duplicate commit to retry." : ""}`);
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
    stdout.write(`Usage: node scripts/agent-pr.mjs --message TEXT [--model NAME] [--files PATH ...]

Without --files, commits the reviewed staged changes. --files must be last.
Requires Node 20+, Git, gh, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY_PATH.
Discovers your configured App's bot identity, pushes the current feature branch to origin,
and creates a draft PR only when no open PR exists. Never force-pushes or merges.
An invocation authorizes commit, push, and PR creation. Keep secrets out of arguments.
`);
    return 0;
  }
  try {
    const result = await publishAgentPr(options, dependencies);
    stdout.write(`Committed ${result.commit.slice(0, 7)} as ${result.botName} and pushed to origin.\n`);
    stdout.write(result.createdPullRequest ? "Created a draft pull request.\n" : "Updated the branch for its existing pull request.\n");
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof AgentPrError ? error.message : "agent-pr failed; details were withheld to protect credentials."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
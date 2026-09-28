import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCommitMessage, createAppJwt, main,
  mintInstallationToken, parseArgs, parseOrigin, publishAgentPr,
} from "../scripts/agent-pr.mjs";
import { AgentPolicyError, loadAgentPolicy, parseAgentPolicy } from "../scripts/load-agent-policy.mjs";

const policySource = readFileSync(new URL("../examples/agent-policy.yml", import.meta.url), "utf8");
const approvedPolicyFile = { type: "file", encoding: "base64", content: Buffer.from(policySource).toString("base64") };
const AGENT = "example-org-agent";
const BOT_NAME = `${AGENT}[bot]`;
const BOT_EMAIL = `789+${BOT_NAME}@users.noreply.github.com`;
const bot = { id: 789, login: BOT_NAME, type: "Bot" };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = Date.UTC(2026, 8, 27, 12);
const installation = { id: 456, app_id: 123, app_slug: AGENT, suspended_at: null };
const access = { token: "test-installation-token", expires_at: new Date(now + 3_600_000).toISOString() };
const credentials = { appId: "123", privateKey, owner: "example-owner", repository: "example-repo" };
const cwd = fileURLToPath(new URL("../", import.meta.url));
const commitSha = "a".repeat(40);
const repository = { full_name: "example-owner/example-repo", default_branch: "main", archived: false };

function mockGitHub(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url === `https://api.github.com/users/${encodeURIComponent(BOT_NAME)}`) return Response.json(bot);
    if (url.endsWith("/contents/agent-policy.yml?ref=main")) return Response.json(approvedPolicyFile);
    if (url.includes("/rules/branches/")) return Response.json([]);
    if (url.includes("/branches/")) return Response.json({ name: decodeURIComponent(url.split("/branches/")[1]), protected: false });
    assert.ok(responses.length, "Unexpected GitHub request");
    const response = responses.shift();
    return response instanceof Response ? response : Response.json(response);
  };
  return { calls, fetchImpl, now };
}

test("App JWT uses RS256, a backdated iat, and a short expiration", () => {
  const jwt = createAppJwt("123", privateKey, now);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iat: now / 1000 - 60,
    exp: now / 1000 + 540,
    iss: "123",
  });
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
});

test("installation token is scoped to the origin repository and required write permissions", async () => {
  const github = mockGitHub([installation, access]);
  assert.deepEqual(await mintInstallationToken(credentials, github), { token: access.token, appSlug: AGENT });
  assert.deepEqual(github.calls.map((call) => [call.method, call.url]), [
    ["GET", "https://api.github.com/repos/example-owner/example-repo/installation"],
    ["POST", "https://api.github.com/app/installations/456/access_tokens"],
  ]);
  assert.deepEqual(JSON.parse(github.calls[1].body), {
    repositories: ["example-repo"],
    permissions: { contents: "write", pull_requests: "write" },
  });
  assert.equal(github.calls[0].redirect, "error");
  assert.ok(github.calls[0].headers.Authorization.startsWith("Bearer "));
});

test("a different or suspended App installation is rejected before minting a token", async () => {
  for (const invalid of [
    { ...installation, app_slug: "invalid slug" },
    { ...installation, app_slug: undefined },
    { ...installation, app_id: 999 },
    { ...installation, suspended_at: new Date(now).toISOString() },
  ]) {
    const github = mockGitHub([invalid]);
    await assert.rejects(mintInstallationToken(credentials, github), /active installation/);
    assert.equal(github.calls.length, 1);
  }
});

test("JWT errors never include the supplied key material", () => {
  assert.throws(() => createAppJwt("bad-id", privateKey, now), /numeric App ID/);
  assert.throws(
    () => createAppJwt("123", "test-private-material-must-not-be-printed", now),
    { message: "Could not sign the App JWT; check the private key outside chat." },
  );
});

test("GitHub error bodies and fetch exceptions are not exposed", async () => {
  await assert.rejects(mintInstallationToken(credentials, {
    now,
    fetchImpl: async () => Response.json({ token: access.token }, { status: 403 }),
  }), { message: "GitHub API request failed (HTTP 403)." });
  await assert.rejects(mintInstallationToken(credentials, {
    now,
    fetchImpl: async () => { throw new Error(access.token); },
  }), { message: "GitHub API request failed; check connectivity and authentication." });
});

test("missing and expired installation tokens are rejected", async () => {
  for (const invalid of [{ expires_at: access.expires_at }, { ...access, expires_at: new Date(now).toISOString() }]) {
    await assert.rejects(mintInstallationToken(credentials, mockGitHub([installation, invalid])), /valid, unexpired installation token/);
  }
});

function mockPublication({ branch = "feat/bot-helper", staged = ["README.md"], indexed = ["README.md", ".env.example"], pullRequests = [] } = {}) {
  const github = mockGitHub([installation, access, repository, pullRequests, new Response(null, { status: 204 })]);
  const commands = [];
  let message;
  let keyReads = 0;
  const dependencies = {
    ...github,
    cwd,
    loadPolicy: () => parseAgentPolicy(policySource),
    env: {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY_PATH: "not-read.pem",
      GIT_AUTHOR_NAME: "Human identity must not be used",
      GIT_COMMITTER_EMAIL: "human@example.com",
      GIT_TRACE: "1",
      GIT_TRACE_CURL: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "inherited-helper",
      GH_TOKEN: "inherited-human-token",
      GH_DEBUG: "api",
    },
    readPrivateKey: () => { keyReads += 1; return privateKey; },
    run: (command, args, options) => {
      commands.push({ command, args, ...options });
      if (command === "gh") return "suppressed command output";
      if (args[0] === "rev-parse") return cwd;
      if (args[0] === "symbolic-ref") return branch;
      if (args[0] === "remote") return "git@github.com:example-owner/example-repo.git\n";
      if (args[0] === "config") return "";
      if (args[0] === "show") return policySource;
      if (args[0] === "diff" || args[0] === "diff-tree") return staged.map((file) => `${file}\0`).join("");
      if (args[0] === "ls-files" || args[0] === "ls-tree") return indexed.map((file) => `${file}\0`).join("");
      if (args.includes("commit")) { message = options.input; return "commit output"; }
      if (args[0] === "log") return [commitSha, BOT_NAME, BOT_EMAIL, BOT_NAME, BOT_EMAIL, message].join("\0");
      if (args[0] === "push" || args[0] === "add") return "";
      throw new Error("Unexpected command");
    },
  };
  return { dependencies, commands, requests: github.calls, keyReads: () => keyReads };
}

test("origin parsing supports GitHub SSH and HTTPS without exposing credentials", () => {
  for (const origin of [
    "git@github.com:example-owner/example-repo.git",
    "ssh://git@github.com/example-owner/example-repo.git",
    "https://github.com/example-owner/example-repo",
  ]) {
    assert.deepEqual(parseOrigin(origin), { owner: "example-owner", repository: "example-repo" });
  }
  for (const origin of [
    "https://user:test-secret@github.com/owner/repo.git",
    "https://github.com.example.com/owner/repo.git",
    "file:///somewhere/repo.git",
    "https://github.com/owner/repo.git?token=test-secret",
  ]) {
    assert.throws(() => parseOrigin(origin), (error) => !error.message.includes("test-secret"));
  }
});

test("CLI builds canonical trailers with unknown or a selected model", () => {
  assert.equal(buildCommitMessage("feat: helper", undefined, AGENT), `feat: helper\n\nAI-Agent: ${AGENT}\nAI-Model: unknown\n`);
  assert.match(buildCommitMessage("feat: helper", "test-model", AGENT), /AI-Model: test-model\n$/);
  assert.throws(() => buildCommitMessage("feat: helper"), /verified App slug/);
  assert.deepEqual(parseArgs(["--message", "feat: helper", "--model", "test-model", "--files", "README.md"]), {
    message: "feat: helper", model: "test-model", files: ["README.md"],
  });
  assert.throws(() => parseArgs(["--message", "feat: helper", "--files"]), /--files must be last/);
  assert.throws(() => parseArgs([]), /--message/);
  assert.throws(() => buildCommitMessage("feat: helper", "unknown\nAI-Agent: someone-else"), /single-line/);
});

test("publication commits both bot identities, pushes without token arguments, and creates a draft PR", async () => {
  const mock = mockPublication();
  const output = [];
  const status = await main(["--message", "feat: helper", "--model", "test-model"], {
    ...mock.dependencies,
    stdout: { write: (text) => output.push(text) },
    stderr: { write: (text) => output.push(text) },
  });
  assert.equal(status, 0);
  const commit = mock.commands.find((call) => call.args.includes("commit"));
  assert.equal(commit.env.GIT_AUTHOR_NAME, BOT_NAME);
  assert.equal(commit.env.GIT_COMMITTER_NAME, BOT_NAME);
  assert.equal(commit.env.GIT_AUTHOR_EMAIL, BOT_EMAIL);
  assert.equal(commit.env.GIT_COMMITTER_EMAIL, BOT_EMAIL);
  assert.equal(commit.input, buildCommitMessage("feat: helper", "test-model", AGENT));
  const identityRequest = mock.requests.find((call) => call.url.includes("/users/"));
  assert.equal(identityRequest.url, `https://api.github.com/users/${encodeURIComponent(BOT_NAME)}`);
  assert.equal(identityRequest.headers.Authorization, `Bearer ${access.token}`);
  assert.equal(commit.env.GH_TOKEN, undefined);
  const push = mock.commands.find((call) => call.args[0] === "push");
  assert.deepEqual(push.args, ["push", "--no-follow-tags", "https://github.com/example-owner/example-repo.git", `${commitSha}:refs/heads/feat/bot-helper`]);
  const encodedToken = Buffer.from(`x-access-token:${access.token}`).toString("base64");
  assert.equal(push.env.GIT_CONFIG_VALUE_4, `AUTHORIZATION: basic ${encodedToken}`);
  assert.equal(push.env.GIT_CONFIG_KEY_6, "protocol.allow");
  assert.equal(push.env.GIT_CONFIG_VALUE_6, "never");
  assert.equal(push.env.GIT_CONFIG_KEY_7, "protocol.https.allow");
  assert.equal(push.env.GIT_CONFIG_VALUE_7, "always");
  const create = mock.commands.find((call) => call.command === "gh" && call.args[0] === "pr");
  assert.ok(create.args.includes("--draft"));
  assert.equal(create.args[create.args.indexOf("--title") + 1], "[agent] helper");
  assert.equal(create.env.GH_TOKEN, access.token);
  assert.equal(create.env.GH_DEBUG, undefined);
  assert.equal(push.env.GIT_TRACE, undefined);
  assert.equal(push.env.GIT_TRACE_CURL, undefined);
  assert.ok(mock.requests.some((call) => call.url.endsWith("/pulls?state=open&head=example-owner%3Afeat%2Fbot-helper")));
  assert.equal(mock.requests.at(-1).method, "DELETE");
  assert.equal(mock.requests.at(-1).url, "https://api.github.com/installation/token");
  for (const secret of [access.token, encodedToken, "inherited-human-token"]) {
    assert.ok(!JSON.stringify(mock.commands.map((call) => call.args)).includes(secret));
    assert.ok(!output.join("").includes(secret));
  }
});

test("an existing open PR is reused without running gh pr create", async () => {
  const mock = mockPublication({ pullRequests: [{ number: 7 }] });
  const result = await publishAgentPr({ message: "fix: helper" }, mock.dependencies);
  assert.equal(result.createdPullRequest, false);
  assert.ok(!mock.commands.some((call) => call.command === "gh" && call.args[0] === "pr"));
});

test("missing, invalid, or insufficient local policy denies publication before commands, key access, or network calls", async () => {
  for (const source of [undefined, "default: allow", "version: 1\ndefault: deny\n", policySource.replace("open_pr, ", "")]) {
    const mock = mockPublication();
    mock.dependencies.loadPolicy = () => {
      if (source === undefined) throw new AgentPolicyError("Missing policy; no capabilities are authorized.");
      return parseAgentPolicy(source);
    };
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /policy|agent-policy/i);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.commands.length, 0);
    assert.equal(mock.requests.length, 0);
  }
});

test("workflow files in the index or explicit paths require human publication before key or token access", async () => {
  for (const file of [".github/workflows/check-agent-trailers.yml", ".github/workflows/nested/ci.yml"]) {
    for (const options of [{}, { files: [file] }]) {
      const mock = mockPublication({ staged: [file] });
      await assert.rejects(publishAgentPr({ message: "feat: helper", ...options }, mock.dependencies), /A human must publish changes under \.github\/workflows\//);
      assert.equal(mock.keyReads(), 0);
      assert.equal(mock.requests.length, 0);
      assert.ok(!mock.commands.some((call) => call.args[0] === "add" || call.args.includes("commit") || call.args[0] === "push"));
    }
  }
  const explicit = mockPublication({ staged: ["README.md"] });
  await assert.rejects(publishAgentPr({ message: "feat: helper", files: [".github/workflows/new.yml"] }, explicit.dependencies), /A human must publish/);
  assert.equal(explicit.keyReads(), 0);
  assert.equal(explicit.requests.length, 0);
});

test("--merge-when-green is opt-in and requires the merger role even if coder.merge is granted", async () => {
  assert.equal(parseArgs(["--message", "feat: helper", "--merge-when-green"]).mergeWhenGreen, true);
  assert.equal(parseArgs(["--message", "feat: helper"]).mergeWhenGreen, undefined);
  for (const source of [policySource, policySource.replace("comment, label", "comment, label, merge")]) {
    const mock = mockPublication();
    mock.dependencies.loadPolicy = () => parseAgentPolicy(source);
    await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /policy denies merger\.merge/);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.commands.length, 0);
    assert.equal(mock.requests.length, 0);
  }
});

test("--merge-when-green also requires merge in the reviewed default-branch policy", async () => {
  const mock = mockPublication();
  mock.dependencies.loadPolicy = () => parseAgentPolicy(policySource.replace(/merger:\r?\n    allow: \[\]/, "merger:\n    allow: [merge]"));
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /policy denies merger\.merge/);
  assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
  assert.equal(mock.requests.at(-1).method, "DELETE");
});

function mockMergePublication({ draft = false, existing = true, checkRuns } = {}) {
  const mock = mockPublication({ pullRequests: existing ? [{ number: 7 }] : [] });
  const source = policySource.replace(/merger:\r?\n    allow: \[\]/, "merger:\n    allow: [merge]");
  const pull = {
    number: 7, state: "open", merged: false, draft, mergeable: true, mergeable_state: "clean",
    head: { sha: commitSha, ref: "feat/bot-helper", repo: { full_name: repository.full_name } },
    base: { ref: "main", repo: { full_name: repository.full_name } },
  };
  const greenCheck = { name: "check-agent-trailers", head_sha: commitSha, status: "completed", conclusion: "success", app: { slug: "github-actions" } };
  let elapsed = 0;
  let listReads = 0;
  mock.dependencies.clock = () => elapsed;
  mock.dependencies.wait = async (duration) => { elapsed += duration; };
  mock.dependencies.loadPolicy = () => parseAgentPolicy(source);
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    if (command === "gh" && args[1] === "ready") pull.draft = false;
    if (args[0] === "rev-parse" && args[1] === "--verify") return commitSha;
    if (args[0] === "status") return "";
    if (["fetch", "switch", "merge", "merge-base", "update-ref"].includes(args[0])) {
      mock.commands.push({ command, args, ...options });
      if (args[0] === "switch") mock.dependencies.runBranch = args.at(-1);
      return "";
    }
    if (args[0] === "symbolic-ref" && mock.dependencies.runBranch) return mock.dependencies.runBranch;
    const output = originalRun(command, args, options);
    return args[0] === "show" ? source : output;
  };
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = async (url, options) => {
    let response;
    if (url.includes("/contents/agent-policy.yml")) response = { ...approvedPolicyFile, content: Buffer.from(source).toString("base64") };
    else if (url.includes("/pulls?")) response = ++listReads === 1 && !existing ? [] : [{ number: 7 }];
    else if (url.endsWith("/pulls/7")) response = pull;
    else if (url.includes("/check-runs?")) {
      const runs = typeof checkRuns === "function" ? checkRuns(greenCheck) : checkRuns ?? [greenCheck];
      response = { total_count: runs.length, check_runs: runs };
    } else if (url.endsWith("/pulls/7/merge")) response = { merged: true, sha: "b".repeat(40) };
    else if (url.includes("/git/ref/heads/")) response = { ref: "refs/heads/feat/bot-helper", object: { type: "commit", sha: commitSha } };
    else if (url.includes("/git/refs/heads/") || options.method === "DELETE") response = new Response(null, { status: 204 });
    else return originalFetch(url, options);
    mock.requests.push({ url, ...options });
    return response instanceof Response ? response : Response.json(response);
  };
  return { ...mock, pull, elapsed: () => elapsed };
}

test("--merge-when-green merges a ready or draft PR by exact SHA and only then deletes its branch", async () => {
  for (const setup of [{}, { draft: true }, { draft: true, existing: false }]) {
    const mock = mockMergePublication(setup);
    const result = await publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies);
    assert.equal(result.merged, true);
    assert.equal(result.remoteBranchDeleted, true);
    assert.equal(result.localBranchDeleted, true);
    assert.equal(result.checkedOutBranch, "main");
    assert.equal(result.mergeCommit, "b".repeat(40));
    const merge = mock.requests.find((call) => call.url.endsWith("/pulls/7/merge"));
    assert.equal(merge.method, "PUT");
    assert.deepEqual(JSON.parse(merge.body), { sha: commitSha, merge_method: "merge", commit_message: buildCommitMessage("feat: helper", undefined, AGENT) });
    const tokenRequest = mock.requests.find((call) => call.url.endsWith("/access_tokens"));
    assert.deepEqual(JSON.parse(tokenRequest.body).permissions, { contents: "write", pull_requests: "write", checks: "read" });
    const deletion = mock.requests.find((call) => call.url.includes("/git/refs/heads/"));
    assert.equal(deletion.method, "DELETE");
    assert.ok(deletion.url.endsWith("/git/refs/heads/feat%2Fbot-helper"));
    assert.ok(mock.requests.indexOf(deletion) > mock.requests.indexOf(merge));
    const fetch = mock.commands.find((call) => call.args[0] === "fetch");
    assert.deepEqual(fetch.args, ["fetch", "--no-tags", "https://github.com/example-owner/example-repo.git", "refs/heads/main:refs/remotes/origin/main"]);
    assert.equal(fetch.env.GIT_CONFIG_VALUE_4, mock.commands.find((call) => call.args[0] === "push").env.GIT_CONFIG_VALUE_4);
    assert.deepEqual(mock.commands.filter((call) => ["switch", "merge", "merge-base", "update-ref"].includes(call.args[0])).map((call) => call.args), [
      ["switch", "--", "main"], ["merge", "--ff-only", "refs/remotes/origin/main"],
      ["merge-base", "--is-ancestor", commitSha, "HEAD"], ["update-ref", "-d", "refs/heads/feat/bot-helper", commitSha],
    ]);
    assert.equal(mock.commands.some((call) => call.command === "gh" && call.args[1] === "ready"), setup.draft === true);
    assert.ok(!mock.commands.some((call) => call.args.some((argument) => ["--approve", "--squash", "--force", "--admin", "--auto"].includes(argument))));
    assert.ok(mock.commands.filter((call) => call.args[0] === "push").every((call) => call.args.at(-1).endsWith(":refs/heads/feat/bot-helper")));
    assert.equal(mock.requests.at(-1).url, "https://api.github.com/installation/token");
  }
});

test("local cleanup stops on staged, unstaged, or untracked worktree changes", async () => {
  for (const dirt of ["M  staged.txt\0", " M unstaged.txt\0", "?? untracked.txt\0"]) {
    const mock = mockMergePublication();
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => args[0] === "status" ? dirt : originalRun(command, args, options);
    await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /PR #7 was merged; the remote feature branch was removed, but local cleanup is incomplete/);
    assert.ok(!mock.commands.some((call) => ["fetch", "switch", "merge", "update-ref"].includes(call.args[0])));
    assert.equal(mock.requests.at(-1).url, "https://api.github.com/installation/token");
  }
});

test("local cleanup stops if the feature SHA changes after the authenticated fetch", async () => {
  const mock = mockMergePublication();
  const originalRun = mock.dependencies.run;
  let fetched = false;
  mock.dependencies.run = (command, args, options) => {
    if (args[0] === "fetch") fetched = true;
    if (fetched && args[0] === "rev-parse" && args[1] === "--verify") return "c".repeat(40);
    return originalRun(command, args, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /published feature SHA changed; local cleanup was stopped.*PR #7 was merged/);
  assert.ok(mock.commands.some((call) => call.args[0] === "fetch"));
  assert.ok(!mock.commands.some((call) => ["switch", "merge", "update-ref"].includes(call.args[0])));
});

test("local cleanup stops if the checked-out branch changes during the fetch", async () => {
  const mock = mockMergePublication();
  const originalRun = mock.dependencies.run;
  let fetched = false;
  mock.dependencies.run = (command, args, options) => {
    if (args[0] === "fetch") fetched = true;
    if (fetched && args[0] === "symbolic-ref") return "feat/another-task";
    return originalRun(command, args, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /local branch or published feature SHA changed; local cleanup was stopped.*PR #7 was merged/);
  assert.ok(mock.commands.some((call) => call.args[0] === "fetch"));
  assert.ok(!mock.commands.some((call) => ["switch", "merge", "update-ref"].includes(call.args[0])));
});

test("a failed fast-forward retains the local feature branch and reports the merged PR", async () => {
  const mock = mockMergePublication();
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    if (args[0] === "merge") throw new Error(access.token);
    return originalRun(command, args, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), (error) => {
    assert.match(error.message, /Default branch fast-forward failed.*PR #7 was merged; the remote feature branch was removed, but local cleanup is incomplete/);
    assert.ok(!error.message.includes(access.token));
    return true;
  });
  assert.ok(mock.commands.some((call) => call.args[0] === "switch"));
  assert.ok(!mock.commands.some((call) => call.args[0] === "update-ref"));
});

test("an advanced feature ref cannot be deleted after the final SHA check", async () => {
  const mock = mockMergePublication();
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    if (args[0] === "update-ref") throw new Error("ref changed while deleting");
    return originalRun(command, args, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /Local feature branch deletion failed.*PR #7 was merged; the remote feature branch was removed, but local cleanup is incomplete/);
  assert.ok(mock.commands.some((call) => call.args[0] === "merge-base"));
  assert.equal(mock.requests.at(-1).url, "https://api.github.com/installation/token");
});

test("--merge-when-green never attempts a merge or branch deletion when the trailer check is red", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "neutral", "skipped"]) {
    const mock = mockMergePublication({ draft: true, checkRuns: (green) => [{ ...green, conclusion }] });
    await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /did not succeed on the head SHA/);
    assert.ok(!mock.requests.some((call) => call.url.endsWith("/merge") || call.url.includes("/git/refs/heads/")));
    assert.ok(!mock.commands.some((call) => call.command === "gh" && call.args[1] === "ready"));
  }
});

test("--merge-when-green waits for a pending check on the same head SHA", async () => {
  let reads = 0;
  const mock = mockMergePublication({ checkRuns: (green) => ++reads === 1 ? [{ ...green, status: "in_progress", conclusion: null }] : [green] });
  assert.equal((await publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies)).merged, true);
  assert.equal(mock.elapsed(), 5_000);
});

test("a merge grant alone never merges without --merge-when-green", async () => {
  const mock = mockMergePublication();
  const result = await publishAgentPr({ message: "feat: helper" }, mock.dependencies);
  assert.equal(result.merged, undefined);
  assert.ok(!mock.requests.some((call) => call.url.includes("/check-runs?") || call.url.endsWith("/merge") || call.url.includes("/git/refs/heads/")));
  const tokenRequest = mock.requests.find((call) => call.url.endsWith("/access_tokens"));
  assert.equal(JSON.parse(tokenRequest.body).permissions.checks, undefined);
});

test("--merge-when-green rejects another PR head or a check for another SHA, name, or App", async () => {
  const moved = mockMergePublication();
  moved.pull.head.sha = "c".repeat(40);
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, moved.dependencies), /no longer matches the published head SHA/);
  assert.ok(!moved.requests.some((call) => call.url.endsWith("/merge")));
  for (const change of [{ head_sha: "c".repeat(40) }, { name: "another-check" }, { app: { slug: AGENT } }]) {
    const mock = mockMergePublication({ checkRuns: (green) => [{ ...green, ...change }] });
    await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /GitHub Actions check on the exact published head SHA/);
    assert.ok(!mock.requests.some((call) => call.url.endsWith("/merge") || call.url.includes("/git/refs/heads/")));
  }
});

test("--merge-when-green times out on missing checks or outstanding review requirements without self-approval", async () => {
  for (const state of ["missing-check", "review-required"]) {
    const mock = mockMergePublication(state === "missing-check" ? { checkRuns: [] } : {});
    if (state === "review-required") mock.pull.mergeable_state = "blocked";
    await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /Timed out waiting/);
    assert.ok(mock.elapsed() <= 600_000);
    assert.ok(!mock.requests.some((call) => call.url.endsWith("/merge") || call.url.includes("/reviews") || call.url.includes("/git/refs/heads/")));
    assert.ok(!mock.commands.some((call) => call.args.includes("review") || call.args.includes("--approve")));
    assert.equal(mock.requests.at(-1).method, "DELETE");
  }
});

test("--merge-when-green rechecks the exact head after marking a draft ready", async () => {
  let reads = 0;
  const mock = mockMergePublication({ draft: true, checkRuns: (green) => [{ ...green, conclusion: ++reads === 1 ? "success" : "failure" }] });
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /did not succeed/);
  assert.ok(mock.commands.some((call) => call.command === "gh" && call.args[1] === "ready"));
  assert.ok(!mock.requests.some((call) => call.url.endsWith("/merge")));
});

test("--merge-when-green respects a merge grant revoked while waiting", async () => {
  const mock = mockMergePublication({ checkRuns: (green) => [{ ...green, status: "in_progress", conclusion: null }] });
  const originalWait = mock.dependencies.wait;
  const originalLoadPolicy = mock.dependencies.loadPolicy;
  let revoked = false;
  mock.dependencies.loadPolicy = (options) => revoked ? parseAgentPolicy(policySource) : originalLoadPolicy(options);
  mock.dependencies.wait = async (duration) => {
    await originalWait(duration);
    revoked = true;
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /policy denies merger\.merge/);
  assert.ok(!mock.requests.some((call) => call.url.endsWith("/merge")));
});

test("--merge-when-green revalidates the reviewed merge grant immediately before merging", async () => {
  const mock = mockMergePublication();
  const originalFetch = mock.dependencies.fetchImpl;
  let policyReads = 0;
  mock.dependencies.fetchImpl = (url, options) => {
    if (url.includes("/contents/agent-policy.yml") && ++policyReads === 3) return Response.json(approvedPolicyFile);
    return originalFetch(url, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /policy denies merger\.merge/);
  assert.ok(mock.requests.some((call) => call.url.includes("/check-runs?")));
  assert.ok(!mock.requests.some((call) => call.url.endsWith("/merge")));
});

test("--merge-when-green never deletes a branch after an unconfirmed or rejected merge", async () => {
  for (const response of [Response.json({ merged: false }), Response.json({ message: access.token }, { status: 409 })]) {
    const mock = mockMergePublication();
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => url.endsWith("/merge") ? response : originalFetch(url, options);
    await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), (error) => {
      assert.match(error.message, /did not confirm a successful merge|HTTP 409/);
      assert.ok(!error.message.includes(access.token));
      return true;
    });
    assert.ok(!mock.requests.some((call) => call.url.includes("/git/refs/heads/")));
    assert.equal(mock.requests.at(-1).url, "https://api.github.com/installation/token");
  }
});

test("--merge-when-green preserves a branch that advanced after the confirmed merge", async () => {
  const mock = mockMergePublication();
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = (url, options) => url.includes("/git/ref/heads/")
    ? Response.json({ ref: "refs/heads/feat/bot-helper", object: { type: "commit", sha: "c".repeat(40) } }) : originalFetch(url, options);
  await assert.rejects(publishAgentPr({ message: "feat: helper", mergeWhenGreen: true }, mock.dependencies), /PR #7 was merged; remote-branch cleanup may be incomplete/);
  assert.ok(mock.requests.some((call) => call.url.endsWith("/merge")));
  assert.ok(!mock.requests.some((call) => call.url.includes("/git/refs/heads/")));
});

test("the coder CLI refuses merge, protected push, deploy, and role or policy overrides", async () => {
  for (const flag of ["--merge", "--push-protected", "--deploy", "--role", "--policy"]) {
    const mock = mockPublication();
    const output = [];
    assert.equal(await main(["--message", "feat: helper", flag], {
      ...mock.dependencies, stderr: { write: (text) => output.push(text) },
    }), 2);
    assert.ok(output.length);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.commands.length, 0);
    assert.equal(mock.requests.length, 0);
  }
});

test("policy edits cannot be staged or selected through the agent publisher", async () => {
  for (const options of [{ files: ["agent-policy.yml"] }, {}]) {
    const mock = mockPublication({ staged: ["agent-policy.yml"] });
    await assert.rejects(publishAgentPr({ message: "feat: helper", ...options }, mock.dependencies), /cannot publish changes to root agent-policy/);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.requests.length, 0);
  }
});

test("a different, missing, or denying default-branch policy prevents self-grants", async () => {
  for (const response of [
    Response.json({ message: "Not found" }, { status: 404 }),
    Response.json({ ...approvedPolicyFile, content: Buffer.from("version: 1\ndefault: deny\n").toString("base64") }),
    Response.json({ ...approvedPolicyFile, content: Buffer.from(policySource.replace("comment, label", "comment")).toString("base64") }),
  ]) {
    const mock = mockPublication();
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => url.includes("/contents/agent-policy.yml") ? response : originalFetch(url, options);
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /HTTP 404|policy denies|differs from/);
    assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
    assert.equal(mock.requests.at(-1).method, "DELETE");
  }
});

test("a protected branch or matching ruleset requires push_protected and is refused", async () => {
  for (const protectedBy of ["legacy", "ruleset"]) {
    const mock = mockPublication({ branch: "release" });
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => {
      if (protectedBy === "ruleset" && url.includes("/rules/branches/")) return Response.json([{ type: "pull_request" }]);
      if (protectedBy === "legacy" && url.endsWith("/branches/release") && !url.includes("/rules/branches/")) return Response.json({ name: "release", protected: true });
      return originalFetch(url, options);
    };
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /policy denies coder\.push_protected/);
    assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
    assert.equal(mock.requests.at(-1).method, "DELETE");
  }
});

test("branch-protection lookup errors fail closed instead of assuming an unprotected branch", async () => {
  const mock = mockPublication();
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = (url, options) => url.includes("/rules/branches/")
    ? Response.json({ message: access.token }, { status: 403 }) : originalFetch(url, options);
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /HTTP 403/);
  assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
});

test("a policy grant cannot enable protected pushes through the coder-only helper", async () => {
  const source = policySource.replace("commit_branch,", "commit_branch, push_protected,");
  const mock = mockPublication();
  mock.dependencies.loadPolicy = () => parseAgentPolicy(source);
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = (url, options) => {
    if (url.includes("/contents/agent-policy.yml")) return Response.json({ ...approvedPolicyFile, content: Buffer.from(source).toString("base64") });
    if (url.includes("/rules/branches/")) return Response.json([{ type: "pull_request" }]);
    return originalFetch(url, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /unsupported by the coder helper/);
  assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
});

test("a changed policy in the committed tree cannot hide behind a clean working copy", async () => {
  const mock = mockPublication();
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => args[0] === "show"
    ? policySource.replace("comment, label", "comment, label, merge") : originalRun(command, args, options);
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), (error) => {
    assert.match(error.message, /differs from the default branch/);
    assert.match(error.message, /local commit remains/);
    return true;
  });
  assert.ok(!mock.commands.some((call) => call.args[0] === "push"));
  assert.equal(mock.requests.at(-1).method, "DELETE");
});

test("new protection discovered after the commit prevents the push", async () => {
  const mock = mockPublication();
  const originalFetch = mock.dependencies.fetchImpl;
  let protectionChecks = 0;
  mock.dependencies.fetchImpl = (url, options) => {
    if (url.includes("/rules/branches/") && ++protectionChecks === 2) return Response.json([{ type: "pull_request" }]);
    return originalFetch(url, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /denies coder\.push_protected/);
  assert.ok(mock.commands.some((call) => call.args.includes("commit")));
  assert.ok(!mock.commands.some((call) => call.args[0] === "push"));
});

test("a new branch can be published when no applicable rules are returned", async () => {
  const mock = mockPublication();
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = (url, options) => url.includes("/branches/") && !url.includes("/rules/branches/")
    ? Response.json({ message: "Not found" }, { status: 404 }) : originalFetch(url, options);
  assert.equal((await publishAgentPr({ message: "feat: helper" }, mock.dependencies)).createdPullRequest, true);
});

test("an invalid or human account cannot stand in for the configured App bot", async () => {
  for (const invalid of [{ ...bot, type: "User" }, { ...bot, login: "another-app[bot]" }, { ...bot, id: 0 }]) {
    const mock = mockPublication();
    const originalFetch = mock.dependencies.fetchImpl;
    let revoked = false;
    mock.dependencies.fetchImpl = (url, options) => {
      if (url.includes("/users/")) return Response.json(invalid);
      if (options.method === "DELETE") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return originalFetch(url, options);
    };
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /bot identity for the configured App/);
    assert.ok(revoked);
    assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
  }
});

test("the onboarding manifest is owner-only with explicit minimal permissions and placeholder callbacks", () => {
  const manifest = JSON.parse(readFileSync(new URL("../docs/app-manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "YOUR-ACCOUNT-agent-coder");
  assert.equal(manifest.url, "https://github.com/R4yHarris/github-agent-contracts");
  assert.equal(manifest.public, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.default_permissions, {
    metadata: "read", contents: "write", issues: "write", pull_requests: "write", checks: "read",
  });
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.hook_attributes.active, false);
  assert.equal(new URL(manifest.hook_attributes.url).hostname, "example.invalid");
  assert.equal(new URL(manifest.redirect_url).hostname, "example.invalid");
  assert.deepEqual(Object.keys(manifest).sort(), [
    "name", "url", "description", "public", "hook_attributes", "redirect_url",
    "request_oauth_on_install", "default_permissions", "default_events",
  ].sort());
});

test("both PR workflows expose the documented required-check name", () => {
  for (const path of [
    "../.github/workflows/check-agent-trailers.yml",
    "../examples/consumer-repo/.github/workflows/check-agent-trailers.yml",
  ]) {
    const workflow = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.match(workflow, /jobs:\n  trailers:\n    name: check-agent-trailers\n/);
  }
});

test("the environment template lists only the two empty publisher settings", () => {
  const lines = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(lines, ["GITHUB_APP_ID=", "GITHUB_APP_PRIVATE_KEY_PATH="]);
});

test("specified files are staged literally, without including unrelated staged files", async () => {
  const mock = mockPublication();
  await publishAgentPr({ message: "docs: helper", files: ["README.md"] }, mock.dependencies);
  const add = mock.commands.find((call) => call.args[0] === "add");
  assert.deepEqual(add.args, ["add", "--", "README.md"]);
  assert.equal(add.env.GIT_LITERAL_PATHSPECS, "1");
  const unrelated = mockPublication({ staged: ["AGENTS.md"] });
  await assert.rejects(publishAgentPr({ message: "docs: helper", files: ["README.md"] }, unrelated.dependencies), /Unrelated files are already staged/);
  assert.equal(unrelated.keyReads(), 0);
});

test("protected files and paths outside the repository are rejected before reading the key", async () => {
  for (const file of [".env", ".env.local", "app.pem", "signing.key", "../outside.txt", ".git/config"]) {
    const mock = mockPublication({ staged: [file], indexed: [file] });
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /Refusing to commit|inside this repository/);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.requests.length, 0);
  }
  const mock = mockPublication({ indexed: ["README.md", ".env"] });
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /Refusing to commit/);
});

test("main and master are rejected before authentication", async () => {
  for (const branch of ["main", "master"]) {
    const mock = mockPublication({ branch });
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /feature branch/);
    assert.equal(mock.keyReads(), 0);
  }
});

test("push failures with secret-bearing output are sanitized and still revoke the token", async () => {
  const mock = mockPublication();
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    if (args[0] === "push") throw new Error(`failure with ${access.token}`);
    return originalRun(command, args, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), (error) => {
    assert.match(error.message, /Branch push failed/);
    assert.match(error.message, /local commit remains/);
    assert.ok(!error.message.includes(access.token));
    return true;
  });
  assert.equal(mock.requests.at(-1).method, "DELETE");
  assert.ok(!mock.commands.some((call) => call.command === "gh" && call.args[0] === "pr"));
});

test("help needs no environment or key and does not publish", async () => {
  const output = [];
  assert.equal(await main(["--help"], { env: {}, stdout: { write: (text) => output.push(text) } }), 0);
  assert.match(output.join(""), /GITHUB_APP_PRIVATE_KEY_PATH/);
  assert.match(output.join(""), /--files/);
  assert.match(output.join(""), /merger\.merge/);
});

test("missing environment and an empty index fail before key access or network calls", async () => {
  const missing = mockPublication();
  delete missing.dependencies.env.GITHUB_APP_ID;
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, missing.dependencies), /Set GITHUB_APP_ID/);
  assert.equal(missing.keyReads(), 0);
  const empty = mockPublication({ staged: [] });
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, empty.dependencies), /Stage reviewed changes/);
  assert.equal(empty.requests.length, 0);
});

test("the configured private-key path is blocked even without a key extension", async () => {
  const mock = mockPublication({ staged: ["app-secret"], indexed: ["app-secret"] });
  mock.dependencies.env.GITHUB_APP_PRIVATE_KEY_PATH = "app-secret";
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /private-key path/);
  assert.equal(mock.keyReads(), 0);
});

test("a nonstandard default branch is rejected and its token revoked", async () => {
  const mock = mockPublication({ branch: "release" });
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = (url, options) => {
    if (url.endsWith("/example-repo")) return Response.json({ ...repository, default_branch: "release" });
    return originalFetch(url, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /default branch/);
  assert.ok(!mock.commands.some((call) => call.args.includes("commit")));
  assert.equal(mock.requests.at(-1).method, "DELETE");
});

test("a branch switch during authentication prevents commit and push", async () => {
  const mock = mockPublication();
  const originalRun = mock.dependencies.run;
  let branchReads = 0;
  mock.dependencies.run = (command, args, options) => {
    if (args[0] === "symbolic-ref" && ++branchReads > 1) return "feat/another-task";
    return originalRun(command, args, options);
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /branch changed/);
  assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
});

test("Git URL rewrites cannot switch the App-authenticated push to human SSH credentials", async () => {
  for (const rewrite of ["insteadof", "pushinsteadof"]) {
    const mock = mockPublication();
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => args[0] === "config"
      ? `url.ssh://git@github.com/.${rewrite}\nhttps://github.com/\0`
      : originalRun(command, args, options);
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /Git URL rewrite/);
    assert.equal(mock.keyReads(), 0);
    assert.ok(!mock.commands.some((call) => call.args.includes("commit") || call.args[0] === "push"));
  }
});

test("post-commit identity or protected-file changes are rejected before push", async () => {
  for (const changed of ["identity", "files"]) {
    const mock = mockPublication();
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => {
      if (changed === "files" && args[0] === "ls-tree") return "README.md\0.env\0";
      const output = originalRun(command, args, options);
      return changed === "identity" && args[0] === "log" ? output.replace(BOT_EMAIL, "human@example.com") : output;
    };
    await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /bot identity|environment file/);
    assert.ok(!mock.commands.some((call) => call.args[0] === "push"));
    assert.equal(mock.requests.at(-1).method, "DELETE");
  }
});

test("a failed PR lookup is not mistaken for a missing PR", async () => {
  const mock = mockPublication({ pullRequests: Response.json({ message: access.token }, { status: 403 }) });
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.ok(!error.message.includes(access.token));
    return true;
  });
  assert.ok(!mock.commands.some((call) => call.command === "gh" && call.args[0] === "pr"));
  assert.equal(mock.requests.at(-1).method, "DELETE");
});

test("local Git integration commits selected and staged files with bot provenance while publication stays mocked", async (context) => {
  const directory = mkdtempSync(join(cwd, ".agent-pr-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const commands = [];
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(GIT_|GH_|GITHUB_APP_)/i.test(name) && !/^(GITHUB_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(name)
  ));
  const localGit = (args, options = {}) => execFileSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${join(directory, "no-hooks")}`,
    ...args,
  ], { cwd: directory, env: gitEnvironment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
  localGit(["init", "--quiet", "--initial-branch=feat/test-publication", "--object-format=sha1"]);
  writeFileSync(join(directory, "agent-policy.yml"), policySource);
  localGit(["add", "--", "agent-policy.yml"]);
  localGit(["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test: policy fixture"]);
  const github = mockGitHub([
    installation, access, repository, [], new Response(null, { status: 204 }),
    installation, access, repository, [{ number: 1 }], new Response(null, { status: 204 }),
  ]);
  const dependencies = {
    ...github,
    cwd: directory,
    loadPolicy: loadAgentPolicy,
    env: { ...gitEnvironment, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: "never-read.pem" },
    readPrivateKey: () => privateKey,
    run: (command, args, options) => {
      commands.push({ command, args });
      if (command === "gh" || args[0] === "push") return "";
      if (args[0] === "remote") return "https://github.com/example-owner/example-repo.git";
      return localGit(args, options);
    },
  };
  writeFileSync(join(directory, "selected.txt"), "selected contents\n");
  writeFileSync(join(directory, "untouched.txt"), "not part of this commit\n");
  const first = await publishAgentPr({ message: "feat: selected files", files: ["selected.txt"] }, dependencies);
  assert.match(first.commit, /^[0-9a-f]{40}$/);
  assert.equal(first.createdPullRequest, true);
  assert.equal(localGit(["ls-tree", "-r", "--name-only", "HEAD"]).trim(), "agent-policy.yml\nselected.txt");
  assert.equal(localGit(["log", "-1", "--format=%an%n%ae%n%cn%n%ce"]).trim(), [BOT_NAME, BOT_EMAIL, BOT_NAME, BOT_EMAIL].join("\n"));
  assert.ok(localGit(["log", "-1", "--format=%B"]).includes(`AI-Agent: ${AGENT}\nAI-Model: unknown`));
  writeFileSync(join(directory, "selected.txt"), "updated contents\n");
  localGit(["add", "--", "selected.txt"]);
  const second = await publishAgentPr({ message: "fix: staged file", model: "test-model" }, dependencies);
  assert.notEqual(second.commit, first.commit);
  assert.equal(second.createdPullRequest, false);
  assert.match(localGit(["log", "-1", "--format=%B"]), /AI-Model: test-model/);
  assert.equal(localGit(["status", "--porcelain"]).trim(), "?? untouched.txt");
  assert.deepEqual(commands.filter((call) => call.args[0] === "push").map((call) => call.args.at(-1)), [
    `${first.commit}:refs/heads/feat/test-publication`,
    `${second.commit}:refs/heads/feat/test-publication`,
  ]);
  assert.equal(commands.filter((call) => call.command === "gh" && call.args[0] === "pr").length, 1);
});
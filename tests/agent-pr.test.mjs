import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCommitMessage, buildInstallationPermissions, createAppJwt, main,
  mintInstallationToken, parseArgs, parseOrigin, publishAgentPr as publishAgentPrRaw, upsertAgentRun,
} from "../scripts/agent-pr.mjs";
import { AgentPolicyError, loadAgentPolicy, parseAgentPolicy } from "../scripts/load-agent-policy.mjs";
import { packAgentRun, parseTrailers } from "../scripts/parse-agent-run.mjs";

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
const runEnvironment = {
  AI_PROVIDER: "anthropic", AI_MODEL: "claude-sonnet-4.5", AI_MODEL_VERSION: "20250901", AI_EFFORT: "high",
  AI_CONTEXT_USED: "18234", AI_CONTEXT_MAX: "200000", AI_CONTEXT_OUT: "2510", AI_SESSION: "ses_01K8", AI_TASK: "feat-auth",
};
const compactRun = "1|anthropic|claude-sonnet-4.5@20250901|h|18234/200000|2510|ses_01K8|feat-auth";

function publishAgentPr(options, dependencies) {
  return publishAgentPrRaw({ ...options, model: options.model ?? dependencies.env.AI_MODEL ?? "test-model" }, dependencies);
}

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

test("GitHub App installation tokens can opt into orchestration scopes while keeping core publication permissions", async () => {
  const github = mockGitHub([installation, access]);
  const token = await mintInstallationToken({
    ...credentials,
    additionalPermissions: {
      actions: "read",
      deployments: "read",
      environments: "read",
      issues: "write",
      organization_projects: "write",
      repository_projects: "write",
      variables: "read",
    },
  }, github);
  assert.deepEqual(token, { token: access.token, appSlug: AGENT });
  assert.deepEqual(JSON.parse(github.calls[1].body), {
    repositories: ["example-repo"],
    permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      actions: "read",
      deployments: "read",
      environments: "read",
      issues: "write",
      organization_projects: "write",
      repository_projects: "write",
      variables: "read",
    },
  });
});

test("additional installation permissions reject invalid names and excessive access", () => {
  for (const additionalPermissions of [
    { projects: "write" },
    { actions: "write" },
    { deployments: "write" },
    { environments: "write" },
    { variables: "write" },
    { administration: "write" },
  ]) {
    assert.throws(
      () => buildInstallationPermissions({ additionalPermissions }),
      /Unsupported additional installation permission/,
    );
  }
  assert.throws(
    () => buildInstallationPermissions({ additionalPermissions: null }),
    /must be an object/,
  );
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

test("CLI builds canonical trailers only with an actual model id", () => {
  assert.equal(buildCommitMessage("feat: helper", "gpt-5", AGENT), `feat: helper\n\nAI-Agent: ${AGENT}\nAI-Model: gpt-5\n`);
  assert.throws(() => buildCommitMessage("feat: helper", undefined, AGENT), /actual single-line model id/);
  assert.throws(() => buildCommitMessage("feat: helper", "UNKNOWN", AGENT), /actual single-line model id/);
  assert.throws(() => buildCommitMessage("feat: helper", "n/a", AGENT), /actual single-line model id/);
  assert.throws(() => buildCommitMessage("feat: helper", "\u2028gpt-5", AGENT), /actual single-line model id/);
  assert.throws(() => buildCommitMessage("feat: helper", "gpt-5"), /verified App slug/);
  assert.deepEqual(parseArgs(["--message", "feat: helper", "--model", "test-model", "--files", "README.md"]), {
    message: "feat: helper", model: "test-model", files: ["README.md"],
  });
  assert.equal(parseArgs(["--message", "feat: helper"], { AI_MODEL: "env-model" }).model, "env-model");
  assert.equal(parseArgs(["--message", "feat: helper", "--model", "gpt-5"], { AI_MODEL: "env-model" }).model, "gpt-5");
  assert.throws(() => parseArgs(["--message", "feat: helper", "--files"]), /--files must be last/);
  assert.throws(() => parseArgs([]), /--message/);
  assert.throws(() => parseArgs(["--message", "feat: helper"]), /model id/);
  assert.throws(() => parseArgs(["--message", "feat: helper"], { AI_MODEL: " " }), /model id/);
  assert.throws(() => parseArgs(["--message", "feat: helper", "--model", "unknown"], { AI_MODEL: "env-model" }), /model id/);
  assert.throws(() => buildCommitMessage("feat: helper", "unknown\nAI-Agent: someone-else"), /single-line/);
});

test("--model gpt-5 commits both bot identities, pushes without token arguments, and creates a draft PR", async () => {
  const mock = mockPublication();
  const output = [];
  const status = await main(["--message", "feat: helper", "--model", "gpt-5"], {
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
  assert.equal(commit.input, buildCommitMessage("feat: helper", "gpt-5", AGENT));
  assert.match(commit.input, /\nAI-Model: gpt-5\n$/);
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

test("AI-Run PR body upsert replaces exactly one tagged pair and preserves other text", () => {
  const block = `<!-- agent-run:1 -->\n\`${compactRun}\``;
  assert.equal(upsertAgentRun("", compactRun), block);
  assert.equal(upsertAgentRun("Description.", compactRun), `Description.\n\n${block}`);
  const existing = "Description.\n\n<!-- agent-run:1 -->\n`old-value`\n\n## Review\nHuman text.";
  const expected = `Description.\n\n${block}\n\n## Review\nHuman text.`;
  assert.equal(upsertAgentRun(existing, compactRun), expected);
  assert.equal(upsertAgentRun(expected, compactRun), expected);
  assert.equal(upsertAgentRun(existing, null), existing);
  assert.equal(upsertAgentRun("<!-- agent-run:1 -->\nHuman text.", compactRun), `${block}\nHuman text.`);
  const duplicate = upsertAgentRun(`${existing}\n\n<!-- agent-run:1 -->\n\`another-value\``, compactRun);
  assert.equal(duplicate.match(/<!-- agent-run:1 -->/g).length, 1);
  assert.equal(duplicate.match(new RegExp(compactRun.replaceAll("|", "\\|"), "g")).length, 1);
  assert.ok(duplicate.includes("Human text."));
  assert.ok(!duplicate.includes("another-value"));
  assert.equal(upsertAgentRun("Description.\r\n\r\n<!-- agent-run:1 -->\r\n`old`\r\nEnd.", compactRun), `Description.\r\n\r\n${block}\r\nEnd.`);
});

test("AI-Run is omitted when environment input is absent, including with --model alone", async () => {
  for (const model of [undefined, "explicit-model"]) {
    const mock = mockPublication();
    await publishAgentPr({ message: "feat: helper", model }, mock.dependencies);
    const commit = mock.commands.find((call) => call.args.includes("commit"));
    assert.ok(!commit.input.includes("AI-Run:"));
    const create = mock.commands.find((call) => call.command === "gh" && call.args[1] === "create");
    assert.ok(!create.args[create.args.indexOf("--body") + 1].includes("agent-run:1"));
    assert.ok(!mock.requests.some((call) => call.method === "PATCH"));
  }
});

test("AI-Run uses supplied environment data and AI_MODEL, with --model taking precedence", async () => {
  for (const explicitModel of [undefined, "cli-model"]) {
    const mock = mockPublication();
    Object.assign(mock.dependencies.env, runEnvironment, { AI_EVAL: "must-not-be-published" });
    const output = [];
    const args = ["--message", "feat: helper", ...(explicitModel ? ["--model", explicitModel] : [])];
    assert.equal(await main(args, { ...mock.dependencies, stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => output.push(text) } }), 0);
    const expectedModel = explicitModel ?? runEnvironment.AI_MODEL;
    const expectedRun = packAgentRun(runEnvironment, expectedModel);
    const commit = mock.commands.find((call) => call.args.includes("commit"));
    assert.deepEqual(parseTrailers(commit.input), { "AI-Agent": AGENT, "AI-Model": expectedModel, "AI-Run": expectedRun });
    assert.equal(commit.input.match(/^AI-Run:/gm).length, 1);
    const create = mock.commands.find((call) => call.command === "gh" && call.args[1] === "create");
    const body = create.args[create.args.indexOf("--body") + 1];
    assert.ok(body.endsWith(`<!-- agent-run:1 -->\n\`${expectedRun}\``));
    assert.ok(!body.includes("AI-Run:"));
    assert.ok(!commit.input.includes("AI-Eval") && !body.includes("AI-Eval"));
    assert.ok(!body.includes("must-not-be-published"));
  }
});

test("AI-Run missing slots use sentinels and invalid effort fails before authentication", async () => {
  const partial = mockPublication();
  partial.dependencies.env.AI_PROVIDER = "local";
  await publishAgentPr({ message: "feat: helper" }, partial.dependencies);
  assert.equal(parseTrailers(partial.commands.find((call) => call.args.includes("commit")).input)["AI-Run"], "1|local|test-model@unknown|-|-/-|-|-|-");
  const invalid = mockPublication();
  Object.assign(invalid.dependencies.env, runEnvironment, { AI_EFFORT: "secret-invalid-effort" });
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, invalid.dependencies), { message: "Invalid AI-Run effort; see docs/METRICS.md." });
  assert.equal(invalid.keyReads(), 0);
  assert.equal(invalid.requests.length, 0);
  assert.equal(invalid.commands.length, 0);
});

test("AI-Run upserts the current PR body without replacing human content or creating a second PR", async () => {
  for (const existingBody of [
    "Human description.\n\n<!-- agent-run:1 -->\n`old-value`\n\nReview notes.",
    "Human description.", null,
    `Human description.\n\n<!-- agent-run:1 -->\n\`${compactRun}\``,
  ]) {
    const mock = mockPublication({ pullRequests: [{ number: 7 }] });
    Object.assign(mock.dependencies.env, runEnvironment);
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => {
      if (url.endsWith("/pulls/7")) {
        mock.requests.push({ url, ...options });
        return Response.json({
          number: 7, state: "open", body: existingBody,
          head: { sha: commitSha, ref: "feat/bot-helper", repo: { full_name: repository.full_name } },
        });
      }
      return originalFetch(url, options);
    };
    await publishAgentPr({ message: "feat: helper" }, mock.dependencies);
    const patches = mock.requests.filter((call) => call.method === "PATCH");
    const expectedBody = upsertAgentRun(existingBody, compactRun);
    assert.equal(patches.length, existingBody === expectedBody ? 0 : 1);
    if (patches.length) assert.deepEqual(JSON.parse(patches[0].body), { body: expectedBody });
    assert.ok(!mock.commands.some((call) => call.command === "gh" && call.args[1] === "create"));
  }
});

test("AI-Run changes made by a commit hook are rejected before pushing", async () => {
  const mock = mockPublication();
  Object.assign(mock.dependencies.env, runEnvironment);
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    const output = originalRun(command, args, options);
    return args[0] === "log" ? output.replace("|h|", "|x|") : output;
  };
  await assert.rejects(publishAgentPr({ message: "feat: helper" }, mock.dependencies), /required bot identity and trailers/);
  assert.ok(!mock.commands.some((call) => call.args[0] === "push"));
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
  assert.equal(parseArgs(["--message", "feat: helper", "--model", "test-model", "--merge-when-green"]).mergeWhenGreen, true);
  assert.equal(parseArgs(["--message", "feat: helper", "--model", "test-model"]).mergeWhenGreen, undefined);
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

function mockResumePublication({ agentRun = compactRun, ...setup } = {}) {
  const mock = mockMergePublication(setup);
  const message = buildCommitMessage("fix: original publication", "claude-sonnet-4.5", AGENT, agentRun);
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    const output = originalRun(command, args, options);
    if (args[0] === "log") return [commitSha, BOT_NAME, BOT_EMAIL, BOT_NAME, BOT_EMAIL, message].join("\0");
    if (args[0] === "diff") return "";
    return output;
  };
  Object.assign(mock.dependencies.env, runEnvironment, { AI_MODEL: "different-retry-model", AI_SESSION: "different-session", AI_EFFORT: "invalid" });
  mock.pull.body = "Original human description.";
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = async (url, options) => {
    let response;
    if (url.endsWith("/protection/required_status_checks")) response = new Response(null, { status: 404 });
    else if (url.includes("/status?")) response = { sha: commitSha, total_count: 0, statuses: [] };
    else if (url.endsWith("/pulls/7") && options.method === "PATCH") {
      mock.pull.body = JSON.parse(options.body).body;
      response = mock.pull;
    } else return originalFetch(url, options);
    mock.requests.push({ url, ...options });
    return response instanceof Response ? response : Response.json(response);
  };
  return { ...mock, message };
}

function assertNoResumePublication(mock, { metadata = false, merge = false } = {}) {
  assert.ok(!mock.commands.some((call) => call.args.includes("commit") || ["add", "push"].includes(call.args[0]) ||
    (call.command === "gh" && call.args[1] === "create")));
  if (!metadata) assert.ok(!mock.requests.some((call) => call.method === "PATCH"));
  if (!merge) {
    assert.ok(!mock.requests.some((call) => call.method === "PUT" || call.url.includes("/git/refs/heads/")));
    assert.ok(!mock.commands.some((call) => ["fetch", "switch", "update-ref"].includes(call.args[0]) ||
      (call.command === "gh" && call.args[1] === "ready")));
  }
}

test("--resume CLI pins an existing SHA and refuses new commit inputs before any effects", async () => {
  assert.deepEqual(parseArgs(["--resume", commitSha], runEnvironment), { resume: commitSha, files: [] });
  for (const args of [
    ["--resume"], ["--resume", "abc"], ["--resume", "A".repeat(40)],
    ["--resume", commitSha, "--message", "new commit"], ["--resume", commitSha, "--model", "gpt-5"],
    ["--resume", commitSha, "--files", "README.md"],
  ]) {
    const mock = mockResumePublication();
    assert.equal(await main(args, { ...mock.dependencies, stderr: { write() {} } }), 2);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.commands.length, 0);
    assert.equal(mock.requests.length, 0);
  }
});

test("--resume restores only committed metadata, preserves model/session/unknowns, and never republishes", async () => {
  for (const agentRun of [compactRun, "1|-|claude-sonnet-4.5@unknown|-|-/-|-|-|-", null]) {
    const mock = mockResumePublication({ agentRun });
    const output = [];
    assert.equal(await main(["--resume", commitSha], {
      ...mock.dependencies, stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => output.push(text) },
    }), 0);
    assertNoResumePublication(mock, { metadata: agentRun !== null });
    assert.equal(mock.pull.body, agentRun === null ? "Original human description." : upsertAgentRun("Original human description.", agentRun));
    assert.ok(!mock.pull.body.includes("different-session"));
    assert.ok(output.join("").includes("no commit, push, or PR creation"));
    assert.ok(!output.join("").includes("Committed"));
    assert.deepEqual(JSON.parse(mock.requests.find((call) => call.url.endsWith("/access_tokens")).body).permissions,
      { contents: "write", pull_requests: "write", checks: "read" });
    assert.equal(mock.requests.at(-1).url, "https://api.github.com/installation/token");
  }
});

test("a post-push stale PR head refusal can resume the identical published commit without another publication", async () => {
  const failed = mockPublication({ pullRequests: [{ number: 7 }] });
  Object.assign(failed.dependencies.env, runEnvironment);
  const originalFetch = failed.dependencies.fetchImpl;
  failed.dependencies.fetchImpl = (url, options) => url.endsWith("/pulls/7")
    ? Response.json({ number: 7, state: "open", head: { sha: "c".repeat(40) } }) : originalFetch(url, options);
  await assert.rejects(publishAgentPrRaw({ message: "fix: original publication" }, failed.dependencies),
    /metadata was not updated.*local commit remains/);
  assert.equal(failed.commands.filter((call) => call.args.includes("commit")).length, 1);
  assert.equal(failed.commands.filter((call) => call.args[0] === "push").length, 1);
  assert.ok(!failed.requests.some((call) => call.method === "PATCH"));
  const resumed = mockResumePublication();
  assert.equal(resumed.message, failed.commands.find((call) => call.args.includes("commit")).input);
  const result = await publishAgentPrRaw({ resume: commitSha }, resumed.dependencies);
  assert.equal(result.commit, commitSha);
  assert.equal(result.resumed, true);
  assert.equal(result.createdPullRequest, false);
  assert.equal(resumed.pull.body, upsertAgentRun("Original human description.", compactRun));
  assertNoResumePublication(resumed, { metadata: true });
});

test("--resume is idempotent and refuses to replace earlier PR run metadata", async () => {
  const mock = mockResumePublication();
  mock.pull.body = upsertAgentRun(mock.pull.body, compactRun);
  await publishAgentPrRaw({ resume: commitSha }, mock.dependencies);
  assertNoResumePublication(mock);
  const conflicting = mockResumePublication();
  conflicting.pull.body = upsertAgentRun("Human text.", compactRun.replace("ses_01K8", "earlier-session"));
  const original = conflicting.pull.body;
  await assert.rejects(publishAgentPrRaw({ resume: commitSha }, conflicting.dependencies), /will not replace/);
  assert.equal(conflicting.pull.body, original);
  assertNoResumePublication(conflicting);
});

test("--resume refuses dirty worktrees and local head drift before reading credentials", async () => {
  for (const fault of ["staged", "unstaged", "untracked", "head"]) {
    const mock = mockResumePublication();
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => {
      if (fault === "head" && args[0] === "rev-parse" && args[1] === "--verify") return "c".repeat(40);
      if (fault !== "head" && args[0] === "status") return `${fault === "untracked" ? "??" : fault === "staged" ? "M " : " M"} README.md\0`;
      return originalRun(command, args, options);
    };
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /clean worktree/);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.requests.length, 0);
    assertNoResumePublication(mock);
  }
});

test("--resume verifies original author, committer, App slug, model, run, and protected paths", async () => {
  for (const change of [
    (output) => output.replace(BOT_NAME, "Human"),
    (output) => output.replaceAll(BOT_EMAIL, "human@example.com"),
    (output) => output.replace(`\0${BOT_NAME}\0${BOT_EMAIL}\0fix:`, "\0Human\0human@example.com\0fix:"),
    (output) => output.replace(`AI-Agent: ${AGENT}`, "AI-Agent: another-app"),
    (output) => output.replace("AI-Model: claude-sonnet-4.5", "AI-Model: unknown"),
    (output) => output.replace("|claude-sonnet-4.5@", "|another-model@"),
    (output) => output.replace(/AI-Run:.*\n/, "AI-Run: invalid\n"),
    (output) => output.replace(commitSha, "c".repeat(40)),
  ]) {
    const mock = mockResumePublication();
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => {
      const output = originalRun(command, args, options);
      return args[0] === "log" ? change(output) : output;
    };
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /required bot identity and trailers/);
    assertNoResumePublication(mock);
  }
  for (const file of ["agent-policy.yml", ".github/workflows/check.yml", "secret.pem"]) {
    const mock = mockResumePublication();
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => args[0] === (file === "secret.pem" ? "ls-tree" : "diff-tree")
      ? `${file}\0` : originalRun(command, args, options);
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /human|private-key/);
    assertNoResumePublication(mock);
  }
});

test("--resume refuses absent/ambiguous PRs, delivered PRs, forks, target drift, and remote head drift", async () => {
  for (const fault of ["absent", "ambiguous", "merged", "closed", "head", "branch", "fork", "base", "base-repo", "remote"]) {
    const mock = mockResumePublication();
    if (fault === "merged") mock.pull.merged = true;
    if (fault === "closed") mock.pull.state = "closed";
    if (fault === "head") mock.pull.head.sha = "c".repeat(40);
    if (fault === "branch") mock.pull.head.ref = "feat/other";
    if (fault === "fork") mock.pull.head.repo.full_name = "another/repo";
    if (fault === "base") mock.pull.base.ref = "another-base";
    if (fault === "base-repo") mock.pull.base.repo.full_name = "another/repo";
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => {
      if (["absent", "ambiguous"].includes(fault) && url.includes("/pulls?")) return Response.json(fault === "absent" ? [] : [{ number: 7 }, { number: 8 }]);
      if (fault === "remote" && url.includes("/git/ref/heads/")) return Response.json({ ref: "refs/heads/feat/bot-helper", object: { type: "commit", sha: "c".repeat(40) } });
      return originalFetch(url, options);
    };
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /existing open PR|exact resume head/);
    assertNoResumePublication(mock);
  }
});

test("--resume requires successful complete exact-head checks from the required App", async () => {
  for (const change of [
    () => [],
    (check) => [{ ...check, status: "in_progress", conclusion: null }],
    (check) => [{ ...check, conclusion: "failure" }],
    (check) => [{ ...check, conclusion: "neutral" }],
    (check) => [{ ...check, head_sha: "c".repeat(40) }],
    (check) => [{ ...check, app: { slug: "another-app" } }],
  ]) {
    const mock = mockResumePublication({ checkRuns: change });
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /Required checks/);
    assertNoResumePublication(mock);
  }
  for (const endpoint of ["/check-runs?", "/status?"]) {
    const mock = mockResumePublication();
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = async (url, options) => {
      const response = await originalFetch(url, options);
      if (!url.includes(endpoint)) return response;
      return Response.json({ ...await response.json(), total_count: 101 });
    };
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /complete exact-head/);
    assertNoResumePublication(mock);
  }
});

test("--resume enforces legacy and ruleset required checks, including App identity and statuses", async () => {
  for (const fault of [null, "missing", "wrong-app", "pending-status"]) {
    const mock = mockResumePublication();
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = async (url, options) => {
      if (url.endsWith("/protection/required_status_checks")) return Response.json({ contexts: ["legacy"], checks: [{ context: "legacy", app_id: null }] });
      if (url.endsWith("/rules/branches/main")) return Response.json([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "tests", integration_id: 99 }] } }]);
      if (url.includes("/status?")) return Response.json({ sha: commitSha, total_count: 1, statuses: [{ context: "legacy", state: fault === "pending-status" ? "pending" : "success" }] });
      const response = await originalFetch(url, options);
      if (!url.includes("/check-runs?")) return response;
      const checks = await response.json();
      if (fault !== "missing") checks.check_runs.push({ name: "tests", head_sha: commitSha, status: "completed", conclusion: "success", app: { id: fault === "wrong-app" ? 100 : 99 } });
      return Response.json({ ...checks, total_count: checks.check_runs.length });
    };
    if (fault === null) await publishAgentPrRaw({ resume: commitSha }, mock.dependencies);
    else await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /Required checks/);
    assertNoResumePublication(mock, { metadata: fault === null });
  }
});

test("--resume refuses revoked policy, changed committed grants, and permission errors without fallback", async () => {
  for (const fault of ["local-policy", "reviewed-policy", "committed-policy", "checks-422", "checks-403", "rules-403"]) {
    const mock = mockResumePublication();
    const originalLoad = mock.dependencies.loadPolicy;
    let reads = 0;
    if (fault === "local-policy") mock.dependencies.loadPolicy = () => ++reads > 1 ? parseAgentPolicy("version: 1\ndefault: deny\n") : originalLoad();
    const originalRun = mock.dependencies.run;
    if (fault === "committed-policy") mock.dependencies.run = (command, args, options) => args[0] === "show" ? policySource : originalRun(command, args, options);
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => {
      if (fault === "reviewed-policy" && url.includes("/contents/agent-policy.yml") && ++reads > 1) return Response.json(approvedPolicyFile);
      if (fault === "checks-422" && url.endsWith("/access_tokens")) return Response.json({ message: access.token }, { status: 422 });
      if ((fault === "checks-403" && url.includes("/check-runs?")) || (fault === "rules-403" && url.endsWith("/rules/branches/main"))) return Response.json({}, { status: 403 });
      return originalFetch(url, options);
    };
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), (error) => {
      assert.match(error.message, /policy denies|differs from|HTTP 422|HTTP 403/);
      assert.ok(!error.message.includes(access.token));
      return true;
    });
    assertNoResumePublication(mock);
  }
});

test("--resume --merge-when-green reuses the merge gates and original provenance without republishing", async () => {
  const mock = mockResumePublication({ draft: true });
  const result = await publishAgentPrRaw({ resume: commitSha, mergeWhenGreen: true }, mock.dependencies);
  assert.equal(result.resumed, true);
  assert.equal(result.merged, true);
  assert.equal(result.createdPullRequest, false);
  assert.equal(result.localBranchDeleted, true);
  assertNoResumePublication(mock, { metadata: true, merge: true });
  assert.deepEqual(JSON.parse(mock.requests.find((call) => call.url.endsWith("/merge")).body),
    { sha: commitSha, merge_method: "merge", commit_message: mock.message });
});

test("--resume stops on head drift after readiness and before merge", async () => {
  const mock = mockResumePublication({ draft: true, agentRun: null });
  const originalRun = mock.dependencies.run;
  mock.dependencies.run = (command, args, options) => {
    const output = originalRun(command, args, options);
    if (command === "gh" && args[1] === "ready") mock.pull.head.sha = "c".repeat(40);
    return output;
  };
  await assert.rejects(publishAgentPrRaw({ resume: commitSha, mergeWhenGreen: true }, mock.dependencies), /exact resume head/);
  assert.ok(!mock.requests.some((call) => call.method === "PUT"));
  assertNoResumePublication(mock, { merge: true });
});

test("--resume refuses remote or repository drift during check reads before metadata writes", async () => {
  for (const fault of ["remote", "origin"]) {
    const mock = mockResumePublication();
    let checking = false;
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = async (url, options) => {
      const response = await originalFetch(url, options);
      if (url.includes("/check-runs?")) checking = true;
      if (checking && fault === "remote" && url.includes("/git/ref/heads/")) return Response.json({ ref: "refs/heads/feat/bot-helper", object: { type: "commit", sha: "c".repeat(40) } });
      return response;
    };
    const originalRun = mock.dependencies.run;
    mock.dependencies.run = (command, args, options) => checking && fault === "origin" && args[0] === "remote"
      ? "https://github.com/other/repository.git\n" : originalRun(command, args, options);
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /exact resume head|origin changed/);
    assertNoResumePublication(mock);
  }
});

test("--resume cannot treat an unreadable protected base as having no required checks", async () => {
  const mock = mockResumePublication();
  const originalFetch = mock.dependencies.fetchImpl;
  mock.dependencies.fetchImpl = (url, options) => url.endsWith("/branches/main") && !url.includes("/rules/")
    ? Response.json({ name: "main", protected: true }) : originalFetch(url, options);
  await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /protected base branch/);
  assertNoResumePublication(mock);
});

test("--resume accepts ruleset-only protected bases and enforces exact-head required App checks", async () => {
  for (const fault of [null, "missing", "pending", "failed", "wrong-app", "wrong-head"]) {
    const mock = mockResumePublication({
      checkRuns: (check) => fault === "missing" ? [] : [{
        ...check,
        app: { slug: "github-actions", id: fault === "wrong-app" ? 999 : 15368 },
        head_sha: fault === "wrong-head" ? "c".repeat(40) : commitSha,
        status: fault === "pending" ? "in_progress" : "completed",
        conclusion: fault === "pending" ? null : fault === "failed" ? "failure" : "success",
      }],
    });
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => {
      if (url.endsWith("/protection/required_status_checks")) return Response.json({ message: "Branch not protected" }, { status: 404 });
      if (url.endsWith("/rules/branches/main")) return Response.json([{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "check-agent-trailers", integration_id: 15368 }] },
      }]);
      if (url.endsWith("/branches/main")) return Response.json({ name: "main", protected: true });
      return originalFetch(url, options);
    };
    if (fault === null) {
      const result = await publishAgentPrRaw({ resume: commitSha }, mock.dependencies);
      assert.equal(result.resumed, true);
      assert.equal(mock.pull.body, upsertAgentRun("Original human description.", compactRun));
    } else await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies), /Required checks/);
    assertNoResumePublication(mock, { metadata: fault === null });
  }
});

test("--resume refuses ruleset-only protected bases with missing, ambiguous, or unavailable controls", async () => {
  for (const fault of ["no-rules", "empty-checks", "unrelated-rule", "missing-parameters", "bad-context", "bad-app",
    "malformed-rules", "rules-403", "rules-404", "rules-422", "base-403", "unknown-protection", "wrong-base"]) {
    const mock = mockResumePublication();
    const originalFetch = mock.dependencies.fetchImpl;
    mock.dependencies.fetchImpl = (url, options) => {
      if (url.endsWith("/protection/required_status_checks")) return Response.json({ message: "Branch not protected" }, { status: 404 });
      if (url.endsWith("/rules/branches/main")) {
        if (fault.startsWith("rules-")) return Response.json({}, { status: Number(fault.slice(6)) });
        if (fault === "malformed-rules") return Response.json({});
        if (fault === "no-rules") return Response.json([]);
        if (fault === "unrelated-rule") return Response.json([{ type: "pull_request" }]);
        if (fault === "missing-parameters") return Response.json([{ type: "required_status_checks" }]);
        return Response.json([{
          type: "required_status_checks",
          parameters: { required_status_checks: fault === "empty-checks" ? [] : [{
            context: fault === "bad-context" ? "" : "check-agent-trailers",
            integration_id: fault === "bad-app" ? "15368" : 15368,
          }] },
        }]);
      }
      if (url.endsWith("/branches/main")) {
        if (fault === "base-403") return Response.json({}, { status: 403 });
        return Response.json({ name: fault === "wrong-base" ? "other" : "main",
          protected: fault === "unknown-protection" ? null : true });
      }
      return originalFetch(url, options);
    };
    await assert.rejects(publishAgentPrRaw({ resume: commitSha }, mock.dependencies),
      /Cannot verify required|HTTP 403|HTTP 404|HTTP 422/);
    assertNoResumePublication(mock);
  }
});

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
    assert.deepEqual(JSON.parse(merge.body), { sha: commitSha, merge_method: "merge", commit_message: buildCommitMessage("feat: helper", "test-model", AGENT) });
    const tokenRequest = mock.requests.find((call) => call.url.endsWith("/access_tokens"));
    assert.deepEqual(JSON.parse(tokenRequest.body).permissions, {
      contents: "write",
      pull_requests: "write",
      checks: "read",
    });
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

test("the onboarding manifest is owner-only with explicit scoped permissions and placeholder callbacks", () => {
  const manifest = JSON.parse(readFileSync(new URL("../docs/app-manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "YOUR-ACCOUNT-agent-coder");
  assert.equal(manifest.url, "https://github.com/R4yHarris/github-agent-contracts");
  assert.equal(manifest.public, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.default_permissions, {
    metadata: "read",
    actions: "read",
    checks: "read",
    contents: "write",
    deployments: "read",
    environments: "read",
    issues: "write",
    organization_projects: "write",
    pull_requests: "write",
    repository_projects: "write",
    variables: "read",
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
  assert.match(output.join(""), /actual model id \(not unknown\)/);
  assert.match(output.join(""), /exits 2 before publication/);
});

test("missing or placeholder model exits two before key access, Git, or GitHub", async () => {
  for (const [args, aiModel] of [
    [["--message", "feat: helper"], ""],
    [["--message", "feat: helper"], "unknown"],
    [["--message", "feat: helper", "--model", ""], "env-model"],
    [["--message", "feat: helper", "--model", "unknown"], "env-model"],
  ]) {
    const mock = mockPublication();
    mock.dependencies.env.AI_MODEL = aiModel;
    const errors = [];
    const status = await main(args, { ...mock.dependencies, stderr: { write: (text) => errors.push(text) } });
    assert.equal(status, 2);
    assert.match(errors.join(""), /actual single-line model id/);
    assert.equal(mock.keyReads(), 0);
    assert.equal(mock.commands.length, 0);
    assert.equal(mock.requests.length, 0);
  }
  const missing = mockPublication();
  await assert.rejects(publishAgentPrRaw({ message: "feat: helper" }, missing.dependencies), /actual single-line model id/);
  assert.equal(missing.keyReads(), 0);
  assert.equal(missing.commands.length, 0);
  assert.equal(missing.requests.length, 0);
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
    !/^(AI_|GIT_|GH_|GITHUB_APP_)/i.test(name) && !/^(GITHUB_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(name)
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
  assert.ok(localGit(["log", "-1", "--format=%B"]).includes(`AI-Agent: ${AGENT}\nAI-Model: test-model`));
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
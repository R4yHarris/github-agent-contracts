import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPullRequest } from "../scripts/check-pr-agent-trailers.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const runner = fileURLToPath(new URL("../scripts/check-pr-agent-trailers.mjs", import.meta.url));

function createHistory(context) {
  const cwd = mkdtempSync(join(repository, ".pr-trailer-test-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 3 }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test author",
    GIT_AUTHOR_EMAIL: "human@example.com",
    GIT_COMMITTER_NAME: "Test committer",
    GIT_COMMITTER_EMAIL: "human@example.com",
  };
  function git(args, options = {}) {
    const result = spawnSync("git", [
      "-c", `core.hooksPath=${join(cwd, "no-hooks")}`,
      "-c", "commit.gpgSign=false",
      ...args,
    ], { cwd, encoding: "utf8", env, ...options });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  }
  function commit(message, authorEmail = "human@example.com") {
    git(["commit", "--quiet", "--allow-empty", "--file=-"], {
      input: message,
      env: { ...env, GIT_AUTHOR_EMAIL: authorEmail },
    });
    return git(["rev-parse", "HEAD"]);
  }
  git(["init", "--quiet", "--object-format=sha1"]);
  return { cwd, commit, baseSha: commit("Initial commit\n") };
}

function runPullRequest(cwd, baseSha, headSha, requireAll = "false") {
  return spawnSync(process.execPath, [runner], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      REQUIRE_ON_ALL_COMMITS: requireAll,
    },
  });
}

test("PR checker scans every commit and distinguishes human, agent, and bot authors", (context) => {
  const history = createHistory(context);
  const human = history.commit("fix typo\n", "123+human@users.noreply.github.com");
  const invalidAgent = history.commit("feat: x\n\nAI-Agent: copilot\n");
  const invalidModel = history.commit("feat: x\n\nAI-Agent: copilot\nAI-Model: unknown\n");
  const validAgent = history.commit("feat: y\n\nAI-Agent: copilot\nAI-Model: gpt-5\n");
  const invalidBot = history.commit("fix: z\n\nAI-Model: gpt-5\n", "123+agent[bot]@users.noreply.github.com");
  const validBot = history.commit(
    "fix: done\n\nAI-Agent: coder\nAI-Model: gpt-5\n",
    "123+agent[bot]@users.noreply.github.com",
  );
  const results = checkPullRequest({ ...history, headSha: validBot });
  assert.deepEqual(results.map((result) => result.sha), [human, invalidAgent, invalidModel, validAgent, invalidBot, validBot]);
  assert.deepEqual(results.map((result) => result.agentAuthored), [false, true, true, true, true, true]);
  assert.deepEqual(results.map((result) => result.missing), [[], ["AI-Model"], ["AI-Model"], [], ["AI-Agent"], []]);

  const result = runPullRequest(history.cwd, history.baseSha, validBot);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 6);
  assert.ok(result.stdout.includes(`${invalidAgent}: missing trailers: AI-Model`));
  assert.ok(result.stdout.includes(`${invalidModel}: missing or invalid trailers: AI-Model`));
  assert.ok(result.stdout.includes(`${invalidBot}: missing trailers: AI-Agent`));
  assert.ok(result.stdout.includes(`${validBot}: OK`));
});

test("PR action defaults to allowing human commits and supports require-on-all-commits", (context) => {
  const history = createHistory(context);
  const headSha = history.commit("fix typo\n");
  const defaultResult = runPullRequest(history.cwd, history.baseSha, headSha);
  assert.equal(defaultResult.status, 0, defaultResult.stderr);

  const requiredResult = runPullRequest(history.cwd, history.baseSha, headSha, "true");
  assert.equal(requiredResult.status, 1, requiredResult.stderr);
  assert.match(requiredResult.stdout, /missing trailers: AI-Agent, AI-Model/);

  const invalidResult = runPullRequest(history.cwd, history.baseSha, headSha, "typo");
  assert.equal(invalidResult.status, 2);
  assert.match(invalidResult.stderr, /require-on-all-commits must be true or false/);
});

test("PR checker fails closed on malformed, missing, or empty commit ranges", (context) => {
  const history = createHistory(context);
  const headSha = history.commit("fix typo\n");
  assert.throws(() => checkPullRequest({ ...history, headSha: "--all" }), /full GitHub commit SHA/);
  assert.throws(() => checkPullRequest({ ...history, headSha, requireAll: "false" }), /must be a boolean/);
  assert.throws(() => checkPullRequest({ ...history, headSha: history.baseSha }), /No commits found/);

  const result = runPullRequest(history.cwd, history.baseSha, "f".repeat(40));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PR trailer check failed:/);
  assert.equal(result.stdout, "");
});

test("PR checker rejects shallow history instead of silently skipping commits", (context) => {
  const history = createHistory(context);
  const headSha = history.commit("fix typo\n");
  writeFileSync(join(history.cwd, ".git", "shallow"), `${history.baseSha}\n`);
  const result = runPullRequest(history.cwd, history.baseSha, headSha);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Full history is required/);
});
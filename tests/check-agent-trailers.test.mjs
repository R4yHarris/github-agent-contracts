import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkMessage, parseTrailers } from "../scripts/check-agent-trailers.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const checker = fileURLToPath(new URL("../scripts/check-agent-trailers.mjs", import.meta.url));

function runChecker(args) {
  return spawnSync(process.execPath, [checker, ...args], { encoding: "utf8" });
}

test("parses trailers after blank line", () => {
  const msg = `feat: x

body

AI-Agent: hermes-coder
AI-Model: unknown
`;
  const t = parseTrailers(msg);
  assert.equal(t["AI-Agent"], "hermes-coder");
  assert.equal(t["AI-Model"], "unknown");
});

test("valid agent message passes", () => {
  const r = checkMessage(`feat: x\n\nAI-Agent: copilot\nAI-Model: gpt\n`);
  assert.equal(r.ok, true);
  assert.equal(r.agentAuthored, true);
});

test("missing AI-Agent on unmarked human message passes", () => {
  const r = checkMessage(`fix typo\n`);
  assert.equal(r.ok, true);
  assert.equal(r.agentAuthored, false);
});

test("missing AI-Model on agent message fails", () => {
  const r = checkMessage(`feat: x\n\nAI-Agent: copilot\n`);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["AI-Model"]);
});

test("--require treats human message as agent-authored", () => {
  const r = checkMessage(`fix typo\n`, true);
  assert.equal(r.agentAuthored, true);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("AI-Agent"));
});

test("trailers need a blank separator", () => {
  const message = "feat: x\nAI-Agent: copilot\nAI-Model: unknown\n";
  assert.deepEqual(parseTrailers(message), {});
  assert.equal(checkMessage(message).ok, false);
});

test("AI-Agent markers outside the footer still require trailers", () => {
  for (const message of [
    "feat: AI-Agent: copilot\n",
    "feat: x\n\nAI-Agent: copilot\n\nMore body text.\n",
  ]) {
    const result = checkMessage(message);
    assert.equal(result.agentAuthored, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["AI-Agent", "AI-Model"]);
  }
});

test("--require rejects a footer with AI-Model but no AI-Agent", () => {
  const result = checkMessage("feat: x\n\nAI-Model: unknown\n", true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["AI-Agent"]);
});

test("GitHub noreply bot authors require trailers", () => {
  for (const email of [
    "123+agent[bot]@users.noreply.github.com",
    "agent[bot]@users.noreply.github.com",
    "agent[bot]@noreply.github.com",
  ]) {
    const result = checkMessage("fix: x\n", false, email);
    assert.equal(result.agentAuthored, true, email);
    assert.deepEqual(result.missing, ["AI-Agent", "AI-Model"], email);
  }
});

test("human noreply addresses and lookalike domains are not bot authors", () => {
  for (const email of [
    "123+human@users.noreply.github.com",
    "human@example.com",
    "agent[bot]@notnoreply.github.com",
    "agent[bot]@users.noreply.github.com.example.com",
  ]) {
    const result = checkMessage("fix: x\n", false, email);
    assert.equal(result.agentAuthored, false, email);
    assert.equal(result.ok, true, email);
  }
});

test("valid bot-authored message passes", () => {
  const result = checkMessage(
    "fix: x\n\nAI-Agent: copilot\nAI-Model: unknown\n",
    false,
    "123+agent[bot]@users.noreply.github.com",
  );
  assert.equal(result.ok, true);
});

test("CRLF messages and recommended trailers are supported", () => {
  const result = checkMessage(
    "fix: x\r\n\r\nAI-Agent: copilot\r\nAI-Model: unknown\r\n" +
    "AI-Session: opaque-id\r\nCo-authored-by: Owner <owner@example.com>\r\n\r\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.trailers["AI-Session"], "opaque-id");
});

test("empty required trailer values fail", () => {
  for (const message of [
    "fix: x\n\nAI-Agent: \nAI-Model: unknown\n",
    "fix: x\n\nAI-Agent: copilot\nAI-Model: \n",
  ]) {
    assert.equal(checkMessage(message).ok, false);
  }
});

test("CLI returns JSON and exits zero for a valid message", () => {
  const result = runChecker([
    "--json", "--message", "fix: x\n\nAI-Agent: copilot\nAI-Model: unknown\n",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(result.stderr, "");
});

test("CLI classifies a bot author and exits one for missing trailers", () => {
  const result = runChecker([
    "--message", "fix: x", "--author-email", "123+agent[bot]@users.noreply.github.com", "--json",
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).missing, ["AI-Agent", "AI-Model"]);
});

test("CLI only requires human trailers when --require is set", () => {
  assert.equal(runChecker(["--message", "fix typo"]).status, 0);
  const result = runChecker(["--require", "--message", "fix typo"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing trailers: AI-Agent, AI-Model/);
});

test("CLI reads a UTF-8 message file", (context) => {
  const directory = mkdtempSync(join(repository, ".trailer-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const messageFile = join(directory, "commit message.txt");
  writeFileSync(messageFile, "fix: x\n\nAI-Agent: copilot\nAI-Model: unknown\n");
  const result = runChecker(["--message-file", messageFile, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("CLI usage errors exit two", () => {
  for (const args of [
    [],
    ["--unknown"],
    ["--message"],
    ["--message-file"],
    ["--author-email"],
    ["--message", "--require"],
    ["--message", "one", "--message", "two"],
    ["--message", "one", "--message-file", checker],
    ["--message-file", join(repository, "missing-directory", "message.txt")],
  ]) {
    const result = runChecker(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI --help documents flags and exits zero", () => {
  const result = runChecker(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ["--help", "--message", "--message-file", "--author-email", "--require", "--json"]) {
    assert.ok(result.stdout.includes(flag), flag);
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  allowsCapability, loadAgentPolicy, main, parseAgentPolicy, requireCapability,
} from "../scripts/load-agent-policy.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const example = readFileSync(new URL("../examples/agent-policy.yml", import.meta.url), "utf8");

function temporaryRepository(context) {
  const directory = mkdtempSync(join(repository, ".policy-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  return directory;
}

test("the example grants coder actions only and leaves merger and deploy empty", () => {
  const policy = parseAgentPolicy(example);
  assert.deepEqual(policy.roles.coder.allow, ["commit_branch", "open_pr", "comment", "label"]);
  assert.deepEqual(policy.roles.merger.allow, []);
  assert.deepEqual(policy.roles.deploy.allow, []);
  assert.equal(allowsCapability(policy, "coder", "commit_branch"), true);
  for (const capability of ["merge", "push_protected", "deploy"]) {
    for (const role of ["coder", "merger", "deploy"]) {
      assert.equal(allowsCapability(policy, role, capability), false);
    }
  }
  assert.throws(() => requireCapability(policy, "merger", "merge"), /denies merger\.merge/);
});

test("omitted roles and allow lists deny everything without inheriting grants", () => {
  for (const source of ["version: 1\ndefault: deny\n", "version: 1\ndefault: deny\nroles: {}\n", "version: 1\ndefault: deny\nroles:\n  coder: {}\n"]) {
    const policy = parseAgentPolicy(source);
    assert.equal(allowsCapability(policy, "coder", "commit_branch"), false);
    assert.equal(allowsCapability(policy, "merger", "merge"), false);
  }
  const policy = parseAgentPolicy(example);
  assert.equal(allowsCapability(policy, "merger", "open_pr"), false);
  assert.equal(allowsCapability(policy, "unknown", "commit_branch"), false);
  assert.equal(allowsCapability(policy, "__proto__", "commit_branch"), false);
  assert.equal(allowsCapability(policy, "coder", "unknown"), false);
  assert.equal(allowsCapability(undefined, "coder", "commit_branch"), false);
});

test("block allow lists and comments produce the same policy as inline lists", () => {
  const source = "# Human-owned policy\r\nversion: 1\r\ndefault: deny # No implicit grants\r\nroles:\r\n  coder:\r\n    allow:\r\n      - commit_branch\r\n      - open_pr\r\n      - comment\r\n      - label\r\n";
  assert.deepEqual(parseAgentPolicy(source), parseAgentPolicy(example));
});

test("an explicit grant applies only to the named role", () => {
  const policy = parseAgentPolicy("version: 1\ndefault: deny\nroles:\n  merger:\n    allow: [merge]\n");
  assert.doesNotThrow(() => requireCapability(policy, "merger", "merge"));
  assert.equal(allowsCapability(policy, "coder", "merge"), false);
  assert.equal(allowsCapability(policy, "merger", "push_protected"), false);
  assert.throws(() => policy.roles.merger.allow.push("deploy"), TypeError);
});

test("invalid, unknown, wildcard, duplicate, and unsupported YAML entries fail closed", () => {
  for (const source of [
    "", "version: 1\n", "default: deny\n", "version: 2\ndefault: deny\n",
    example.replace("default: deny", "default: allow"),
    `${example}default: deny\n`,
    `${example}defaults: allow\n`,
    example.replace("  coder:", "  owner:"),
    example.replace("allow: [commit_branch, open_pr, comment, label]", "allow: [*]"),
    example.replace("allow: [commit_branch, open_pr, comment, label]", "allow: [commit_branch, commit_branch]"),
    example.replace("open_pr", "open_pull_request"),
    example.replace("  merger:", "  coder:"),
    example.replace("    allow: []", "    allow: []\n    allow: [merge]"),
    example.replace("    allow: []", "    deny: []"),
    example.replace("roles:", "roles: &roles"),
    `${example}---\n${example}`,
    example.replace("  coder:", "\tcoder:"),
    example.replace("default: deny", "default: !custom deny"),
    example.replace("  coder:", "  coder: {}\n    allow: [merge]"),
  ]) {
    assert.throws(() => parseAgentPolicy(source), /Invalid or unsupported agent-policy/);
  }
  assert.throws(() => parseAgentPolicy(" ".repeat(65_537)), /no capabilities/);
});

test("a missing or malformed root policy never falls back to the example", (context) => {
  const cwd = temporaryRepository(context);
  assert.throws(() => loadAgentPolicy({ cwd }), /no capabilities are authorized/);
  writeFileSync(join(cwd, "agent-policy.yml"), "default: allow\n");
  assert.throws(() => loadAgentPolicy({ cwd }), /Invalid or unsupported/);
  writeFileSync(join(cwd, "agent-policy.yml"), example);
  assert.deepEqual(loadAgentPolicy({ cwd }), parseAgentPolicy(example));
});

test("the read-only CLI refuses merge with an empty merger allow list", (context) => {
  const cwd = temporaryRepository(context);
  writeFileSync(join(cwd, "agent-policy.yml"), example);
  const output = [];
  const options = { cwd, stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => output.push(text) } };
  assert.equal(main(["--role", "merger", "--capability", "merge"], options), 1);
  assert.match(output.join(""), /denies merger\.merge/);
  assert.equal(main(["--role", "coder", "--capability", "commit_branch"], options), 0);
  assert.equal(main(["--role", "coder", "--capability", "deploy"], options), 1);
  assert.equal(main(["--role", "unknown", "--capability", "merge"], options), 1);
  assert.equal(main(["--policy", "examples/agent-policy.yml"], options), 2);
});
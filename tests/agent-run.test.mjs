import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packAgentRun, parseAgentRun, parseAgentRunMessage } from "../scripts/parse-agent-run.mjs";
import { exportAgentMetrics } from "../scripts/export-agent-metrics.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const parser = fileURLToPath(new URL("../scripts/parse-agent-run.mjs", import.meta.url));
const exporter = fileURLToPath(new URL("../scripts/export-agent-metrics.mjs", import.meta.url));
const model = "claude-sonnet-4.5";
const compact = "1|anthropic|claude-sonnet-4.5@20250901|h|18234/200000|2510|ses_01K8|feat-auth";
const environment = {
  AI_PROVIDER: "anthropic",
  AI_MODEL: model,
  AI_MODEL_VERSION: "20250901",
  AI_EFFORT: "high",
  AI_CONTEXT_USED: "18234",
  AI_CONTEXT_MAX: "200000",
  AI_CONTEXT_OUT: "2510",
  AI_SESSION: "ses_01K8",
  AI_TASK: "feat-auth",
};

test("packs and unpacks the exact schema 1 example", () => {
  assert.equal(packAgentRun(environment), compact);
  assert.deepEqual(parseAgentRun(compact, model), {
    model,
    schema: 1,
    provider: "anthropic",
    model_version: "20250901",
    effort: "h",
    context_used: 18234,
    context_max: 200000,
    context_out: 2510,
    session: "ses_01K8",
    task: "feat-auth",
  });
});

test("omits AI-Run without environment input or without any provider or model", () => {
  assert.equal(packAgentRun({}), null);
  assert.equal(packAgentRun({}, "explicit-model"), null);
  assert.equal(packAgentRun({ AI_PROVIDER: "", AI_MODEL: "", AI_EFFORT: "" }), null);
  assert.equal(packAgentRun({ AI_CONTEXT_USED: "12", AI_SESSION: "session" }), null);
  for (const value of [undefined, null, ""]) assert.equal(parseAgentRun(value), null);
});

test("partial environment uses missing-slot sentinels rather than inventing metadata", () => {
  assert.throws(() => packAgentRun({ AI_PROVIDER: "local" }), /Invalid AI-Run model/);
  assert.equal(packAgentRun({ AI_PROVIDER: "local" }, "gpt-5"), "1|local|gpt-5@unknown|-|-/-|-|-|-");
  assert.equal(packAgentRun({ AI_MODEL: "known-model" }), "1|-|known-model@unknown|-|-/-|-|-|-");
  assert.throws(() => packAgentRun({ AI_MODEL: "unknown" }), /Invalid AI-Run model/);
  assert.throws(() => packAgentRun({ AI_MODEL: "gpt-5\n" }), /Invalid AI-Run model/);
  assert.equal(packAgentRun({ AI_EFFORT: "low" }, "cli-model"), "1|-|cli-model@unknown|l|-/-|-|-|-");
  assert.deepEqual(parseAgentRun("1|-|known-model@unknown|-|-/-|-|-|-"), {
    model: "known-model", schema: 1, provider: null, model_version: "unknown", effort: null,
    context_used: null, context_max: null, context_out: null, session: null, task: null,
  });
});

test("normalizes only the documented effort aliases", () => {
  for (const [input, expected] of [["low", "l"], ["medium", "m"], ["high", "h"], ["max", "x"], ["l", "l"], ["m", "m"], ["h", "h"], ["x", "x"]]) {
    assert.equal(packAgentRun({ ...environment, AI_EFFORT: input }).split("|")[3], expected);
  }
  for (const effort of ["extreme", "HIGH", " high", "h ", "0", "__proto__", "h\nAI-Eval: private-value"]) {
    assert.throws(() => packAgentRun({ ...environment, AI_EFFORT: effort }), { message: "Invalid AI-Run effort; see docs/METRICS.md." });
  }
});

test("ignores unknown trailing fields without changing the first eight columns", () => {
  assert.deepEqual(parseAgentRun(`${compact}|future-key=value||a future field`), parseAgentRun(compact));
  assert.throws(() => parseAgentRun(`2${compact.slice(1)}`), /schema/);
});

test("rejects invalid known columns and mismatched AI-Model", () => {
  const invalidFields = [
    [0, ""], [0, "01"], [1, "unknown"], [1, "OPENAI"],
    [2, `${model}@bad version`], [2, `${model}@`], [2, model], [2, `other@${model}@version`],
    [3, "high"], [3, ""], [4, "1.2/200000"], [4, "1e2/200000"], [4, "-1/200000"],
    [4, "1/2/3"], [4, "1/"], [5, "abc"], [5, "2.5"],
    [6, "has space"], [6, "x".repeat(65)], [7, ""], [7, "task/secret"],
  ];
  for (const [index, value] of invalidFields) {
    const fields = compact.split("|");
    fields[index] = value;
    assert.throws(() => parseAgentRun(fields.join("|")), /Invalid AI-Run/);
  }
  assert.throws(() => parseAgentRun(compact, "another-model"), /model@version/);
  assert.throws(() => parseAgentRun(compact.split("|").slice(0, 7).join("|")), /columns/);
  assert.throws(() => parseAgentRun(compact.replace("|h|", "| h|")), /spacing/);
  assert.throws(() => packAgentRun({ ...environment, AI_SESSION: "session|injection" }), /Invalid AI-Run/);
});

test("preserves zero counts, model paths, token versions, and large integers without rounding", () => {
  const packed = packAgentRun({ ...environment, AI_MODEL: "owner/model:small", AI_MODEL_VERSION: "v1.2_rc-3", AI_CONTEXT_USED: "0", AI_CONTEXT_OUT: "9007199254740993" });
  const parsed = parseAgentRun(packed, "owner/model:small");
  assert.equal(parsed.context_used, 0);
  assert.equal(parsed.context_out, "9007199254740993");
  assert.equal(parsed.model_version, "v1.2_rc-3");
});

function message(run = compact) {
  return `feat: auth\n\nBody text is not exported.\n\nAI-Agent: hermes-coder\nAI-Model: ${model}\nAI-Run: ${run}\n`;
}

test("parses only footer metadata into the exact JSONL record shape", () => {
  const sha = "a".repeat(40);
  const record = parseAgentRunMessage(`${message()}AI-Future: ignored\n`, sha);
  assert.deepEqual(record, { sha, agent: "hermes-coder", ...parseAgentRun(compact, model) });
  assert.deepEqual(Object.keys(record), ["sha", "agent", "model", "schema", "provider", "model_version", "effort", "context_used", "context_max", "context_out", "session", "task"]);
  assert.equal(parseAgentRunMessage("fix: typo\n"), null);
  assert.equal(parseAgentRunMessage(`${message()}\nMore body text\n`), null);
});

test("the parser CLI emits one record, omits absent metadata, and fails on malformed metadata", (context) => {
  const directory = mkdtempSync(join(repository, ".agent-run-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const path = join(directory, "message.txt");
  writeFileSync(path, message());
  const result = spawnSync(process.execPath, [parser, "--message-file", path, "--sha", "a".repeat(40)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), parseAgentRunMessage(message(), "a".repeat(40)));
  const absent = spawnSync(process.execPath, [parser, "--message", "fix: typo"], { encoding: "utf8" });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, "");
  const invalid = spawnSync(process.execPath, [parser, "--message", message("invalid")], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  const usage = spawnSync(process.execPath, [parser, "--message-file"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("JSONL export ignores missing trailers and future fields without leaking message bodies", () => {
  const records = [
    ["a".repeat(40), message()],
    ["b".repeat(40), "fix: typo\n"],
    ["c".repeat(40), message(`${compact}|future-data`)],
  ];
  const jsonl = exportAgentMetrics({ run: (command, args) => {
    assert.equal(command, "git");
    assert.deepEqual(args.slice(-3), ["--end-of-options", "HEAD", "--"]);
    return records.map(([sha, text]) => `${sha}\0${text}\0\n`).join("");
  } });
  assert.deepEqual(jsonl.trim().split("\n").map((line) => JSON.parse(line)), [
    parseAgentRunMessage(message(), "a".repeat(40)), parseAgentRunMessage(message(), "c".repeat(40)),
  ]);
  assert.ok(!jsonl.includes("Body text"));
  assert.ok(!jsonl.includes("future-data"));
  assert.throws(() => exportAgentMetrics({ run: () => `${"a".repeat(40)}\0${message("bad")}\0\n` }), /Invalid AI-Run in commit/);
  assert.equal(exportAgentMetrics({ run: () => "" }), "");
});

test("the export CLI reads a local Git history and respects revision ranges", (context) => {
  const directory = mkdtempSync(join(repository, ".agent-run-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|GH_|GITHUB_APP_)/i.test(name))),
    GIT_AUTHOR_NAME: "test-agent[bot]", GIT_AUTHOR_EMAIL: "1+test-agent[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "test-agent[bot]", GIT_COMMITTER_EMAIL: "1+test-agent[bot]@users.noreply.github.com",
  };
  const git = (args, input) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(directory, "no-hooks")}`, ...args,
  ], { cwd: directory, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git(["init", "--quiet", "--initial-branch=fixture", "--object-format=sha1"]);
  git(["commit", "--quiet", "--allow-empty", "--file=-"], "Initial fixture\n");
  const base = git(["rev-parse", "HEAD"]);
  git(["commit", "--quiet", "--allow-empty", "--file=-"], message());
  const head = git(["rev-parse", "HEAD"]);
  const result = spawnSync(process.execPath, [exporter, "--ref", `${base}..${head}`], { cwd: directory, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), parseAgentRunMessage(message(), head));
  const invalid = spawnSync(process.execPath, [exporter, "--ref", "missing-ref"], { cwd: directory, env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});
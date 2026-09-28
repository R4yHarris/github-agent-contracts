#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentRunError, parseAgentRunMessage } from "./parse-agent-run.mjs";

export function exportAgentMetrics({ cwd = process.cwd(), ref = "HEAD", run = execFileSync } = {}) {
  let history;
  try {
    history = run("git", [
      "log", "--no-show-signature", "--no-color", "--no-decorate", "--reverse",
      "--format=%H%x00%B%x00", "--end-of-options", ref, "--",
    ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new AgentRunError("Could not read local Git history; verify the repository and --ref.");
  }
  const fields = history.split("\0");
  if (fields.length % 2 !== 1 || fields.at(-1).trim() !== "") {
    throw new AgentRunError("Git returned an invalid commit stream; no metrics were exported.");
  }
  const records = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const sha = fields[index].trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
      throw new AgentRunError("Git returned an invalid commit SHA; no metrics were exported.");
    }
    try {
      const record = parseAgentRunMessage(fields[index + 1], sha);
      if (record) records.push(JSON.stringify(record));
    } catch {
      throw new AgentRunError(`Invalid AI-Run in commit ${sha}; no metrics were exported.`);
    }
  }
  return records.length ? `${records.join("\n")}\n` : "";
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(`Usage: node scripts/export-agent-metrics.mjs [--ref REVISION_OR_RANGE]

Export compact AI-Run trailers from local Git history as JSONL (default: HEAD).
Commits without AI-Run are skipped; invalid records fail without partial output.
No network access, analytics service, prompts, traces, evaluations, or quality scores.
Exit 0: exported; 1: history or metadata error; 2: invalid arguments.
`);
    return 0;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== "--ref" || !argv[1] || argv[1].startsWith("-"))) {
    stderr.write("Use --ref REVISION_OR_RANGE or --help.\n");
    return 2;
  }
  try {
    stdout.write(exportAgentMetrics({ ...dependencies, ref: argv[1] ?? "HEAD" }));
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof AgentRunError ? error.message : "Could not export local AI-Run metadata."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
#!/usr/bin/env node
/**
 * Validate agent provenance trailers on a git commit message.
 * Zero dependencies. Node 20+.
 */

import { readFileSync } from "node:fs";

const REQUIRED = ["AI-Agent", "AI-Model"];

function usage(stream = process.stdout) {
  stream.write(`Usage:
  check-agent-trailers.mjs [--require] [--json] (--message TEXT | --message-file PATH)

  Exit 0  OK
  Exit 1  missing required trailers on an agent-authored message
  Exit 2  usage error
`);
}

function parseArgs(argv) {
  const out = { require: false, json: false, message: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--require") {
      out.require = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--message") {
      out.message = argv[++i];
      if (out.message === undefined) throw new Error("--message needs a value");
    } else if (a === "--message-file") {
      const p = argv[++i];
      if (!p) throw new Error("--message-file needs a path");
      out.message = readFileSync(p, "utf8");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

export function parseTrailers(message) {
  const normalized = String(message).replace(/\r\n/g, "\n").trimEnd();
  const trailers = {};
  const lines = normalized.split("\n");
  let i = lines.length - 1;
  const collected = [];
  while (i >= 0 && lines[i].trim() === "") i -= 1;
  while (i >= 0) {
    const line = lines[i];
    const m = /^([A-Za-z0-9][-A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!m) break;
    collected.push([m[1], m[2].trim()]);
    i -= 1;
  }
  for (const [k, v] of collected.reverse()) trailers[k] = v;
  return trailers;
}

export function isAgentAuthored(message, requireAll) {
  if (requireAll) return true;
  const trailers = parseTrailers(message);
  return Object.prototype.hasOwnProperty.call(trailers, "AI-Agent");
}

export function checkMessage(message, requireAll = false) {
  const trailers = parseTrailers(message);
  const agent = isAgentAuthored(message, requireAll);
  const missing = [];
  if (agent) {
    for (const key of REQUIRED) {
      if (!trailers[key] || String(trailers[key]).trim() === "") missing.push(key);
    }
  }
  return {
    agentAuthored: agent,
    trailers,
    missing,
    ok: missing.length === 0,
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    usage(process.stderr);
    process.exit(2);
  }
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (args.message == null) {
    usage(process.stderr);
    process.exit(2);
  }
  const result = checkMessage(args.message, args.require);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`missing trailers: ${result.missing.join(", ")}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-agent-trailers.mjs");

if (isMain) {
  main(process.argv.slice(2));
}

#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDERS = ["anthropic", "openai", "github-copilot", "local", "other"];
const EFFORTS = { low: "l", medium: "m", high: "h", max: "x", l: "l", m: "m", h: "h", x: "x", "-": "-" };
const ENV_KEYS = [
  "AI_PROVIDER", "AI_MODEL", "AI_MODEL_VERSION", "AI_EFFORT", "AI_CONTEXT_USED",
  "AI_CONTEXT_MAX", "AI_CONTEXT_OUT", "AI_SESSION", "AI_TASK",
];

export class AgentRunError extends Error {}

export function parseTrailers(message) {
  const normalized = String(message).replace(/\r\n/g, "\n").trimEnd();
  const trailers = {};
  const lines = normalized.split("\n");
  let index = lines.length - 1;
  const collected = [];
  while (index >= 0 && lines[index].trim() === "") index -= 1;
  while (index >= 0) {
    const match = /^([A-Za-z0-9][-A-Za-z0-9]*):\s*(.*)$/.exec(lines[index]);
    if (!match) break;
    collected.push([match[1], match[2].trim()]);
    index -= 1;
  }
  if (index < 0 || lines[index].trim() !== "") return trailers;
  for (const [key, value] of collected.reverse()) trailers[key] = value;
  return trailers;
}

function invalid(field) {
  throw new AgentRunError(`Invalid AI-Run ${field}; see docs/METRICS.md.`);
}

function count(value, field) {
  if (value === "-") return null;
  if (!/^[0-9]+$/.test(value)) invalid(field);
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

export function parseAgentRun(value, expectedModel) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid("value");
  const fields = value.split("|");
  if (fields.length < 8) invalid("columns (expected at least eight)");
  const [schema, provider, modelVersion, effort, context, output, session, task] = fields;
  if (schema !== "1") invalid("schema (expected 1)");
  if (fields.slice(0, 8).some((field) => field !== field.trim())) invalid("delimiter spacing");
  if (provider !== "-" && !PROVIDERS.includes(provider)) invalid("provider");
  const modelParts = /^([^\s|@`]+)@([A-Za-z0-9._-]+)$/.exec(modelVersion);
  if (!modelParts || (expectedModel !== undefined && modelParts[1] !== expectedModel)) invalid("model@version");
  if (!["l", "m", "h", "x", "-"].includes(effort)) invalid("effort");
  const contextParts = context.split("/");
  if (contextParts.length !== 2) invalid("in/max");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(session)) invalid("session");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(task)) invalid("task");
  return {
    model: modelParts[1],
    schema: 1,
    provider: provider === "-" ? null : provider,
    model_version: modelParts[2],
    effort: effort === "-" ? null : effort,
    context_used: count(contextParts[0], "in"),
    context_max: count(contextParts[1], "max"),
    context_out: count(output, "out"),
    session: session === "-" ? null : session,
    task: task === "-" ? null : task,
  };
}

export function packAgentRun(env = {}, model = env.AI_MODEL ?? "") {
  const values = Object.fromEntries(ENV_KEYS.map((key) => {
    const value = env[key] ?? "";
    if (typeof value !== "string") invalid(key);
    return [key, value];
  }));
  if (!ENV_KEYS.some((key) => values[key] !== "")) return null;
  const effort = values.AI_EFFORT || "-";
  if (!Object.hasOwn(EFFORTS, effort)) invalid("effort");
  if (!values.AI_PROVIDER && !model) return null;
  if (typeof model !== "string" || model.includes("|") || ENV_KEYS.some((key) => values[key].includes("|"))) invalid("field separator");
  const resolvedModel = model || "unknown";
  const packed = [
    "1",
    values.AI_PROVIDER || "-",
    `${resolvedModel}@${values.AI_MODEL_VERSION || "unknown"}`,
    EFFORTS[effort],
    `${values.AI_CONTEXT_USED || "-"}/${values.AI_CONTEXT_MAX || "-"}`,
    values.AI_CONTEXT_OUT || "-",
    values.AI_SESSION || "-",
    values.AI_TASK || "-",
  ].join("|");
  parseAgentRun(packed, resolvedModel);
  return packed;
}

export function parseAgentRunMessage(message, sha = null) {
  const trailers = parseTrailers(message);
  const run = parseAgentRun(trailers["AI-Run"], trailers["AI-Model"]);
  return run ? { sha, agent: trailers["AI-Agent"] ?? null, ...run } : null;
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(`Usage: node scripts/parse-agent-run.mjs [--sha SHA] (--message TEXT | --message-file PATH)

Print one JSONL record for an AI-Run trailer, or nothing if it is absent.
Exit 0: parsed or absent; 1: invalid AI-Run; 2: invalid arguments or unreadable input.
Unknown trailing fields are ignored. No prompts, traces, or AI-Eval comments are exported.
`);
    return 0;
  }
  let message = null;
  let sha = null;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (!["--sha", "--message", "--message-file"].includes(argument)) throw new Error();
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error();
      if (argument === "--sha") {
        if (sha !== null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) throw new Error();
        sha = value;
      } else {
        if (message !== null) throw new Error();
        message = argument === "--message-file" ? readFileSync(value, "utf8") : value;
      }
    }
    if (message === null) throw new Error();
  } catch {
    stderr.write("Choose one readable --message or --message-file input and an optional full --sha; use --help.\n");
    return 2;
  }
  try {
    const record = parseAgentRunMessage(message, sha);
    if (record) stdout.write(`${JSON.stringify(record)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof AgentRunError ? error.message : "Could not parse AI-Run metadata."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
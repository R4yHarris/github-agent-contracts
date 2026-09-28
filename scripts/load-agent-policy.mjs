#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROLES = ["coder", "merger", "deploy"];
const CAPABILITIES = ["commit_branch", "open_pr", "comment", "label", "merge", "push_protected", "deploy"];

export class AgentPolicyError extends Error {}

export function parseAgentPolicy(source) {
  if (typeof source !== "string" || source.length > 65_536) {
    throw new AgentPolicyError("Invalid agent policy; no capabilities are authorized.");
  }
  const policy = { version: 1, default: "deny", roles: {} };
  const rootKeys = new Set();
  const allowKeys = new Set();
  let inRoles = false;
  let role;
  let inAllowList = false;
  const invalid = () => {
    throw new AgentPolicyError("Invalid or unsupported agent-policy.yml; expected the strict version 1 format in docs/POLICY.md.");
  };
  const addCapability = (capability) => {
    if (!CAPABILITIES.includes(capability) || policy.roles[role].allow.includes(capability)) invalid();
    policy.roles[role].allow.push(capability);
  };

  for (const original of source.replace(/\r\n/g, "\n").split("\n")) {
    if (original.includes("\t")) invalid();
    const line = original.replace(/(?:^|\s+)#.*$/, "").trimEnd();
    if (!line) continue;
    const root = /^(version|default|roles):(?: (.*))?$/.exec(line);
    if (root) {
      if (rootKeys.has(root[1])) invalid();
      rootKeys.add(root[1]);
      inRoles = root[1] === "roles" && root[2] === undefined;
      role = undefined;
      inAllowList = false;
      if (root[1] === "version" && root[2] !== "1") invalid();
      if (root[1] === "default" && root[2] !== "deny") invalid();
      if (root[1] === "roles" && root[2] !== undefined && root[2] !== "{}") invalid();
      continue;
    }
    const roleEntry = /^  ([a-z_]+):(?: (.*))?$/.exec(line);
    if (roleEntry) {
      if (!inRoles || !ROLES.includes(roleEntry[1]) || Object.hasOwn(policy.roles, roleEntry[1])) invalid();
      if (roleEntry[2] !== undefined && roleEntry[2] !== "{}") invalid();
      policy.roles[roleEntry[1]] = { allow: [] };
      role = roleEntry[2] === "{}" ? undefined : roleEntry[1];
      inAllowList = false;
      continue;
    }
    const allow = /^    allow:(?: (.*))?$/.exec(line);
    if (allow) {
      if (!inRoles || !role || allowKeys.has(role)) invalid();
      allowKeys.add(role);
      inAllowList = allow[1] === undefined;
      if (!inAllowList) {
        if (!/^\[(?:[a-z_]+(?:, *[a-z_]+)*)?\]$/.test(allow[1])) invalid();
        for (const capability of allow[1].slice(1, -1).split(",").filter(Boolean)) addCapability(capability.trim());
      }
      continue;
    }
    const item = /^      - ([a-z_]+)$/.exec(line);
    if (!item || !inRoles || !role || !inAllowList) invalid();
    addCapability(item[1]);
  }
  if (!rootKeys.has("version") || !rootKeys.has("default")) invalid();
  for (const name of ROLES) {
    policy.roles[name] ??= { allow: [] };
    Object.freeze(policy.roles[name].allow);
    Object.freeze(policy.roles[name]);
  }
  Object.freeze(policy.roles);
  return Object.freeze(policy);
}

export function loadAgentPolicy({ cwd = process.cwd() } = {}) {
  let source;
  try {
    const path = join(cwd, "agent-policy.yml");
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size > 65_536) {
      throw new Error("Not a small regular policy file");
    }
    source = readFileSync(path, "utf8");
  } catch {
    throw new AgentPolicyError("Cannot read a regular root agent-policy.yml; no capabilities are authorized. Ask a human to install or repair the policy.");
  }
  return parseAgentPolicy(source);
}

export function allowsCapability(policy, role, capability) {
  return Boolean(
    policy?.version === 1 && policy.default === "deny" && ROLES.includes(role) &&
    CAPABILITIES.includes(capability) && Array.isArray(policy.roles?.[role]?.allow) &&
    policy.roles[role].allow.includes(capability)
  );
}

export function requireCapability(policy, role, capability) {
  if (!allowsCapability(policy, role, capability)) {
    const action = ROLES.includes(role) && CAPABILITIES.includes(capability) ? `${role}.${capability}` : "the requested capability";
    throw new AgentPolicyError(`Agent policy denies ${action}. No action was authorized.`);
  }
}

export function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(`Usage: node scripts/load-agent-policy.mjs [--role ROLE --capability CAPABILITY]

Read root agent-policy.yml; without flags, print its validated policy.
Missing or invalid policy denies all actions. No example fallback or role inheritance.
Exit 0: valid policy or allowed capability; 1: denied/unreadable/invalid; 2: usage error.
This command does not execute a capability or confer a role on the caller.
`);
    return 0;
  }
  if (argv.length && (argv.length !== 4 || argv[0] !== "--role" || argv[2] !== "--capability")) {
    stderr.write("Use --role ROLE --capability CAPABILITY, or --help.\n");
    return 2;
  }
  try {
    const policy = loadAgentPolicy({ cwd });
    if (argv.length) {
      requireCapability(policy, argv[1], argv[3]);
      stdout.write("Capability allowed by policy; App, repository rules, and human authorization still apply.\n");
    } else {
      stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof AgentPolicyError ? error.message : "Policy check failed; no capabilities are authorized."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
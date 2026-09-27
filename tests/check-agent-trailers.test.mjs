import assert from "node:assert/strict";
import test from "node:test";
import { checkMessage, parseTrailers } from "../scripts/check-agent-trailers.mjs";

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

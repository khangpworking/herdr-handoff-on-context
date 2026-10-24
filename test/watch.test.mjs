import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, skipReason, parseHandoffPath, nextAgentName, handoff, pollOnce, handoffPathFor } from "../src/watch.js";

const quiet = { info() {}, warn() {}, error() {} };

function setup(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hh-"));
  const config = loadConfig({
    HERDR_HANDOFF_DIR: join(dir, "handoffs"),
    HERDR_HANDOFF_SKILL: join(dir, "missing-skill.md"),
    HERDR_HANDOFF_STATE: join(dir, "state.json"),
    HERDR_HANDOFF_CONFIRM_TIMEOUT_MS: "50",
    ...extraEnv,
  });
  return { dir, config };
}

const agent = (over = {}) => ({
  pane_id: "w1:p1",
  name: "c1",
  agent: "claude",
  agent_status: "idle",
  cwd: "/repo",
  agent_session: { kind: "path", value: "/t.jsonl" },
  ...over,
});

// Fake herdr: records calls; `respond(args)` may override the default reply.
function fakeHerdr(handoffFile, respond = () => undefined) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const custom = respond(args);
    if (custom) return custom;
    const [a, b] = args;
    if (a === "agent" && b === "prompt") return { code: 0, stdout: "", stderr: "", json: { result: { agent: { agent_status: "done" } } } };
    if (a === "agent" && b === "read") return { code: 0, stdout: `done\nHANDOFF: ${handoffFile}\n`, stderr: "" };
    if (a === "pane" && b === "split") return { code: 0, stdout: "", stderr: "", json: { result: { pane: { pane_id: "w1:p9" } } } };
    return { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  fn.did = (a, b) => calls.some((c) => c[0] === a && c[1] === b);
  return fn;
}

test("thresholds: claude lower by default, env overrides per kind", () => {
  const c = loadConfig({});
  assert.equal(c.thresholds.claude, 150000);
  assert.equal(c.thresholds.codex, 170000);
  assert.equal(loadConfig({ HERDR_HANDOFF_THRESHOLD: "20000" }).thresholds.pi, 20000);
  assert.equal(loadConfig({ HERDR_HANDOFF_THRESHOLD: "20000", HERDR_HANDOFF_THRESHOLD_PI: "9000" }).thresholds.pi, 9000);
});

test("skipReason: only idle/done agents with a session, once per session", () => {
  const { config } = setup();
  const state = { triggered: {} };
  assert.equal(skipReason(agent(), config, state), undefined);
  assert.match(skipReason(agent({ agent_status: "working" }), config, state), /status/);
  assert.match(skipReason(agent({ agent_status: "blocked" }), config, state), /status/);
  assert.match(skipReason(agent({ agent_session: undefined }), config, state), /no session/);
  assert.match(skipReason(agent({ agent: "zcode" }), config, state), /kind/);
  state.triggered["claude:/t.jsonl"] = {};
  assert.match(skipReason(agent(), config, state), /already/);
});

test("parseHandoffPath: last HANDOFF line wins, backticks ok", () => {
  assert.equal(parseHandoffPath("HANDOFF: <absolute path>\nx\nHANDOFF: `/h/a/b.md`"), "/h/a/b.md");
  assert.equal(parseHandoffPath("nothing here"), undefined);
});

test("nextAgentName: numbered, skips taken names, no -h2-h3 chains", () => {
  assert.equal(nextAgentName({ name: "c1" }, new Set()), "c1-h2");
  assert.equal(nextAgentName({ name: "c1-h2" }, new Set(["c1-h2"])), "c1-h3");
  assert.equal(nextAgentName({ agent: "codex" }, new Set(["codex-h2"])), "codex-h3");
});

test("handoff: happy path starts same kind, prompts with the file, closes old pane", async () => {
  const { dir, config } = setup();
  // Inside the handoff dir, so the newest-file fallback also finds it on Windows.
  mkdirSync(config.handoffDir, { recursive: true });
  const file = join(config.handoffDir, "h.md");
  writeFileSync(file, "x".repeat(500));
  const herdr = fakeHerdr(file);
  const r = await handoff({ agent: agent({ agent: "codex", name: "x1" }), tokens: 180000, config, herdr, log: quiet, existingNames: new Set(), sleep: async () => {} });
  assert.equal(r.ok, true);
  const start = herdr.calls.find((c) => c[1] === "start");
  assert.deepEqual(start.slice(0, 7), ["agent", "start", "x1-h2", "--kind", "codex", "--pane", "w1:p9"]);
  assert.ok(herdr.calls.some((c) => c[1] === "prompt" && c[2] === "x1-h2" && c[3].includes(file)));
  assert.ok(herdr.calls.some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "w1:p1"));
});

test("handoff: agent blocked while writing -> nothing split, nothing closed", async () => {
  const { config } = setup();
  const herdr = fakeHerdr("/none", (args) =>
    args[1] === "prompt" ? { code: 0, stdout: "", stderr: "", json: { result: { agent: { agent_status: "blocked" } } } } : undefined,
  );
  const r = await handoff({ agent: agent(), tokens: 160000, config, herdr, log: quiet, existingNames: new Set() });
  assert.equal(r.ok, false);
  assert.equal(r.step, "write");
  assert.equal(herdr.did("pane", "split"), false);
  assert.equal(herdr.did("pane", "close"), false);
});

test("handoff: new agent never works -> old pane kept", async () => {
  const { dir, config } = setup();
  // Inside the handoff dir, so the newest-file fallback also finds it on Windows.
  mkdirSync(config.handoffDir, { recursive: true });
  const file = join(config.handoffDir, "h.md");
  writeFileSync(file, "x".repeat(500));
  const herdr = fakeHerdr(file, (args) => (args[1] === "wait" ? { code: 1, stdout: "", stderr: "timeout" } : undefined));
  const r = await handoff({ agent: agent(), tokens: 160000, config, herdr, log: quiet, existingNames: new Set(), sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.step, "confirm");
  assert.equal(herdr.did("pane", "close"), false);
});

test("handoff: keepOld renames instead of closing", async () => {
  const { config } = setup({ HERDR_HANDOFF_KEEP_OLD: "1" });
  // Inside the handoff dir, so the newest-file fallback also finds it on Windows.
  mkdirSync(config.handoffDir, { recursive: true });
  const file = join(config.handoffDir, "h.md");
  writeFileSync(file, "x".repeat(500));
  const herdr = fakeHerdr(file);
  const r = await handoff({ agent: agent(), tokens: 160000, config, herdr, log: quiet, existingNames: new Set(), sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(herdr.did("pane", "close"), false);
  assert.ok(herdr.calls.some((c) => c[1] === "rename" && c[3] === "c1-old"));
});

test("pollOnce: hands off over threshold once; dry run and below threshold do nothing", async () => {
  const { config } = setup();
  const list = { code: 0, json: { result: { agents: [agent(), agent({ pane_id: "w1:p2", name: "c2", agent_session: { kind: "path", value: "/u" } })] } } };
  const herdr = async () => list;
  const tokens = { "w1:p1": 160000, "w1:p2": 1000 };
  const handed = [];
  const doHandoff = async ({ agent: a }) => (handed.push(a.pane_id), { ok: true });
  const state = { triggered: {} };
  await pollOnce({ config, herdr, log: quiet, state, read: async (a) => tokens[a.pane_id], doHandoff });
  await pollOnce({ config, herdr, log: quiet, state, read: async (a) => tokens[a.pane_id], doHandoff });
  assert.deepEqual(handed, ["w1:p1"]);

  const dry = [];
  await pollOnce({ config: { ...config, dryRun: true }, herdr, log: quiet, state: { triggered: {} }, read: async () => 999999, doHandoff: async ({ agent: a }) => (dry.push(a), { ok: true }) });
  assert.equal(dry.length, 0);
});

test("handoffPathFor: two agents in the same second get different files", () => {
  const { config } = setup();
  const t = Date.parse("2026-10-24T14:52:00Z");
  const a = handoffPathFor({ agent: "opencode", name: "o1" }, config, t);
  const b = handoffPathFor({ agent: "pi", name: "p1" }, config, t);
  assert.notEqual(a, b);
  assert.match(a, /-opencode-o1\.md$/);
});

test("handoff: herdr misses the turn (prompt stalled) -> waits for the requested file", async () => {
  const { config } = setup();
  mkdirSync(config.handoffDir, { recursive: true });
  let wanted;
  const herdr = fakeHerdr("/none", (args) => {
    if (args[1] === "prompt" && args.includes("--wait")) {
      wanted = /exactly as (\S+)/.exec(args[3])[1];
      writeFileSync(wanted, "x".repeat(500)); // the agent writes it anyway
      return { code: 1, stdout: "", stderr: "", json: { error: { code: "agent_prompt_stalled" } } };
    }
    return undefined;
  });
  const r = await handoff({ agent: agent(), tokens: 160000, config, herdr, log: quiet, existingNames: new Set(), sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.path, wanted);
});

test("handoff: codex review screen is closed with Escape before prompting, never trusted", async () => {
  const { config } = setup();
  mkdirSync(config.handoffDir, { recursive: true });
  let screens = 0;
  const herdr = fakeHerdr("/none", (args) => {
    if (args[1] === "read" && args.includes("visible")) {
      return { code: 0, stdout: screens++ === 0 ? "Hooks  1 hook needs review  t trust all" : "Ask Codex to do anything", stderr: "" };
    }
    if (args[1] === "prompt" && args.includes("--wait")) {
      writeFileSync(/exactly as (\S+)/.exec(args[3])[1], "x".repeat(500));
    }
    return undefined;
  });
  await handoff({ agent: agent({ agent: "codex", name: "x1" }), tokens: 180000, config, herdr, log: quiet, existingNames: new Set(), sleep: async () => {} });
  const keys = herdr.calls.filter((c) => c[1] === "send-keys").map((c) => c.slice(3).join(" "));
  assert.ok(keys.includes("Escape"));
  assert.ok(!keys.some((k) => /\bt\b/i.test(k)));
  const firstEsc = herdr.calls.findIndex((c) => c[1] === "send-keys");
  const firstPrompt = herdr.calls.findIndex((c) => c[1] === "prompt");
  assert.ok(firstEsc < firstPrompt);
});

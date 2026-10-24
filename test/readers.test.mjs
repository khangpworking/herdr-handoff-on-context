import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeContext, codexContext, piContext, opencodeTokens, readContext, resolveSessionPath, codexRolloutFor } from "../src/readers.js";

const j = (...objs) => objs.map((o) => JSON.stringify(o));

test("claude: newest main-thread usage, sidechain ignored", () => {
  const lines = j(
    { type: "assistant", message: { usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } } },
    { type: "assistant", isSidechain: true, message: { usage: { input_tokens: 999999 } } },
    { type: "user" },
  );
  assert.equal(claudeContext(lines), 116);
});

test("codex: last token_count uses last_token_usage, not the running total", () => {
  const lines = j(
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, output_tokens: 5 }, total_token_usage: { input_tokens: 1 } } } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 120000, cached_input_tokens: 110000, output_tokens: 300 }, total_token_usage: { input_tokens: 999999 } } } },
    { type: "event_msg", payload: { type: "token_count", info: null } },
  );
  assert.equal(codexContext(lines), 120300);
});

test("pi: assistant usage incl. cache", () => {
  const lines = j(
    { type: "message", message: { role: "assistant", usage: { input: 1000, output: 20, cacheRead: 5000, cacheWrite: 7 } } },
    { type: "message", message: { role: "user" } },
  );
  assert.equal(piContext(lines), 6027);
});

test("opencode: same formula as the original plugin", () => {
  assert.equal(opencodeTokens({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }), 15);
  assert.equal(opencodeTokens({}), undefined);
});

test("readContext: unknown when herdr reported no session", async () => {
  assert.equal(await readContext({ agent: "claude" }), undefined);
  assert.equal(await readContext({ agent: "zcode", agent_session: { kind: "path", value: "/x" } }), undefined);
});

test("resolveSessionPath: claude session id -> transcript under projects/", () => {
  const home = mkdtempSync(join(tmpdir(), "cl-"));
  mkdirSync(join(home, "projects", "-home-u-repo"), { recursive: true });
  const file = join(home, "projects", "-home-u-repo", "abc-123.jsonl");
  writeFileSync(file, "{}\n");
  const agent = { agent: "claude", agent_session: { kind: "id", value: "abc-123" } };
  assert.equal(resolveSessionPath(agent, { CLAUDE_CONFIG_DIR: home }), file);
  assert.equal(resolveSessionPath({ ...agent, agent_session: { kind: "id", value: "nope" } }, { CLAUDE_CONFIG_DIR: home }), undefined);
});

test("codexRolloutFor: newest rollout for this cwd started after the process", () => {
  const home = mkdtempSync(join(tmpdir(), "cx-"));
  const now = Date.parse("2026-10-24T14:00:00Z");
  const d = new Date(now);
  const dir = join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const write = (name, cwd, ts) => writeFileSync(join(dir, name), JSON.stringify({ type: "session_meta", payload: { cwd, timestamp: ts } }) + "\n");
  write("rollout-a.jsonl", "/repo", "2026-10-24T13:00:00Z"); // before the process started
  write("rollout-b.jsonl", "/other", "2026-10-24T13:40:00Z"); // other folder
  write("rollout-c.jsonl", "/repo", "2026-10-24T13:31:00Z");
  write("rollout-d.jsonl", "/repo", "2026-10-24T13:45:00Z"); // after /new
  const start = Date.parse("2026-10-24T13:30:00Z");
  assert.equal(codexRolloutFor("/repo", start, { CODEX_HOME: home }, now), join(dir, "rollout-d.jsonl"));
  assert.equal(codexRolloutFor("/none", start, { CODEX_HOME: home }, now), undefined);
});

test("readContext: opencode goes by session id", async () => {
  const got = await readContext(
    { agent: "opencode", agent_session: { kind: "id", value: "ses_1" } },
    { opencodeContext: async (id) => (id === "ses_1" ? 42 : 0) },
  );
  assert.equal(got, 42);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeContext, codexContext, piContext, opencodeTokens, readContext } from "../src/readers.js";

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

test("readContext: opencode goes by session id", async () => {
  const got = await readContext(
    { agent: "opencode", agent_session: { kind: "id", value: "ses_1" } },
    { opencodeContext: async (id) => (id === "ses_1" ? 42 : 0) },
  );
  assert.equal(got, 42);
});

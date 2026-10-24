// Context-size readers, one per agent kind.
//
// Each reader answers one question: how many tokens were in the model's
// context window at the agent's most recent model call? That number is what
// fills up toward the window limit, so it is what the watcher compares with
// the threshold. Readers only read local session files the agents already
// write; they never talk to the agent.
//
// Herdr tells us where the session lives (AgentInfo.agent_session):
//   claude, codex, pi -> kind "path" (a JSONL transcript)
//   opencode          -> kind "id"   (a row key in ~/.local/share/opencode/opencode.db)

import { openSync, readSync, fstatSync, closeSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Read at most `maxBytes` from the end of a file and return complete lines,
// newest last. Transcripts grow to many MB; the latest usage entry is always
// near the end.
export function tailLines(path, maxBytes = 4 * 1024 * 1024) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // first line is probably cut in half
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

function lastMatch(lines, pick) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const value = pick(obj);
    if (value !== undefined) return value;
  }
  return undefined;
}

// Claude Code transcript: assistant entries carry message.usage. Context =
// fresh input + cache reads + cache writes + the reply itself. Subagent
// (sidechain) entries run in their own window, so skip them.
export function claudeContext(lines) {
  return lastMatch(lines, (o) => {
    if (o?.type !== "assistant" || o?.isSidechain) return undefined;
    const u = o?.message?.usage;
    if (!u) return undefined;
    return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
  });
}

// Codex rollout: event_msg/token_count events. last_token_usage is the most
// recent model call; its input_tokens already includes cached input.
export function codexContext(lines) {
  return lastMatch(lines, (o) => {
    const p = o?.payload ?? o;
    if (p?.type !== "token_count") return undefined;
    const u = p?.info?.last_token_usage;
    if (!u) return undefined;
    return n(u.input_tokens) + n(u.output_tokens);
  });
}

// pi session: assistant messages carry usage {input, output, cacheRead, cacheWrite}.
export function piContext(lines) {
  return lastMatch(lines, (o) => {
    const m = o?.message ?? o;
    if (m?.role !== "assistant" || !m?.usage) return undefined;
    const u = m.usage;
    return n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
  });
}

// OpenCode message tokens: same formula as the original plugin's getTokenCount.
export function opencodeTokens(info) {
  const t = info?.tokens;
  if (!t || typeof t !== "object") return undefined;
  return n(t.input) + n(t.output) + n(t.reasoning) + n(t.cache?.read) + n(t.cache?.write);
}

export function opencodeDbPath(env = process.env) {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "opencode.db");
}

// OpenCode v1 stores messages in SQLite: table `message` with `session_id`
// and a JSON `data` column. Uses node:sqlite (Node >= 22.13), read-only.
export async function opencodeContext(sessionId, dbPath = opencodeDbPath()) {
  if (!existsSync(dbPath)) return undefined;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 50")
      .all(sessionId);
    for (const row of rows) {
      let info;
      try {
        info = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (info?.role !== "assistant") continue;
      const tokens = opencodeTokens(info);
      if (tokens) return tokens;
    }
    return undefined;
  } finally {
    db.close();
  }
}

const LINE_READERS = { claude: claudeContext, codex: codexContext, pi: piContext };

export const SUPPORTED_KINDS = ["claude", "codex", "opencode", "pi"];

// agent: a herdr AgentInfo. Returns a token count, or undefined when unknown.
export async function readContext(agent, deps = {}) {
  const kind = agent?.agent;
  const session = agent?.agent_session;
  if (!session?.value) return undefined;
  if (kind === "opencode") {
    return (deps.opencodeContext ?? opencodeContext)(session.value);
  }
  const reader = LINE_READERS[kind];
  if (!reader || session.kind !== "path" || !existsSync(session.value)) return undefined;
  return reader((deps.tailLines ?? tailLines)(session.value));
}

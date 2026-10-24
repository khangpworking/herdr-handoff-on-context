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

import { openSync, readSync, fstatSync, closeSync, existsSync, readdirSync, readFileSync } from "node:fs";
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

// Where each agent keeps its transcripts, and how a file name carries the
// session id. Used when herdr reports a session id instead of a path (the
// Claude integration does this).
function sessionRoots(env = process.env) {
  return {
    claude: { root: join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"), match: (name, id) => name === `${id}.jsonl` },
    codex: { root: join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions"), match: (name, id) => name.startsWith("rollout-") && name.endsWith(`${id}.jsonl`) },
    pi: { root: join(homedir(), ".pi", "agent", "sessions"), match: (name, id) => name.endsWith(`_${id}.jsonl`) },
  };
}

function findFile(dir, match, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) if (e.isFile() && match(e.name)) return join(dir, e.name);
  if (depth <= 0) return undefined;
  // Newest directories first: codex nests sessions by YYYY/MM/DD.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const d of dirs) {
    const found = findFile(join(dir, d), match, depth - 1);
    if (found) return found;
  }
  return undefined;
}

const pathCache = new Map();

export function resolveSessionPath(agent, env = process.env) {
  const s = agent?.agent_session;
  if (!s?.value) return undefined;
  if (s.kind === "path") return s.value;
  const key = `${agent.agent}:${s.value}`;
  const cached = pathCache.get(key);
  if (cached && existsSync(cached)) return cached;
  const where = sessionRoots(env)[agent.agent];
  if (!where) return undefined;
  const found = findFile(where.root, (name) => where.match(name, s.value), 3);
  if (found) pathCache.set(key, found);
  return found;
}

// Fallback for Codex when herdr has no session (Codex does not run its herdr
// SessionStart hook until the hook is approved in its review screen). Codex
// 0.16x keeps rollouts open in a shared daemon, so open files cannot map a
// pane to a session. Instead match the rollout header (session_meta): same
// cwd, started at or after the pane's codex process. The newest match wins,
// which also follows /new inside the same process.
export function processStartMs(pid, procRoot = "/proc") {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]); // field 22 overall: starttime
    const btime = Number(/^btime (\d+)/m.exec(readFileSync(join(procRoot, "stat"), "utf8"))[1]);
    return (btime + ticks / 100) * 1000; // USER_HZ is 100 on Linux
  } catch {
    return undefined;
  }
}

function firstLine(path, maxBytes = 256 * 1024) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const len = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, len).toString("utf8").split("\n")[0];
  } finally {
    closeSync(fd);
  }
}

export function codexRolloutFor(cwd, startMs, env = process.env, nowMs = Date.now()) {
  if (!cwd || !startMs) return undefined;
  const root = sessionRoots(env).codex.root;
  let best;
  // Today and the days back to the process start (rollouts nest by YYYY/MM/DD).
  for (let t = nowMs; t >= startMs - 86_400_000; t -= 86_400_000) {
    const d = new Date(t);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      let meta;
      try {
        meta = JSON.parse(firstLine(full))?.payload;
      } catch {
        continue;
      }
      const created = Date.parse(meta?.timestamp ?? "");
      if (meta?.cwd !== cwd || !(created >= startMs - 5000)) continue;
      if (!best || created > best.created) best = { full, created };
    }
  }
  return best?.full;
}

// agent: a herdr AgentInfo. Returns a token count, or undefined when unknown.
export async function readContext(agent, deps = {}) {
  const kind = agent?.agent;
  const session = agent?.agent_session;
  if (!session?.value) return undefined;
  if (kind === "opencode") {
    return (deps.opencodeContext ?? opencodeContext)(session.value);
  }
  const reader = LINE_READERS[kind];
  const path = reader && (deps.resolveSessionPath ?? resolveSessionPath)(agent);
  if (!path || !existsSync(path)) return undefined;
  return reader((deps.tailLines ?? tailLines)(path));
}

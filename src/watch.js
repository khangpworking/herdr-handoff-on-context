// Watch every agent in a herdr session and hand it off to a fresh session of
// the same agent before its context window fills up.
//
// Flow for one agent (all steps go through the herdr CLI):
//   1. agent is idle/done and its context >= threshold
//   2. prompt it to write a handoff document (shared handoff skill) and print
//      "HANDOFF: <path>" as the last line
//   3. split its pane, start the same agent kind in the new pane
//   4. prompt the new agent to read the handoff file and continue
//   5. once the new agent is confirmed "working", close the old pane
//      (or keep it, renamed "<name>-old", when keepOld is set)
//
// The herdr steps (split, confirm-working retry loop, close-after-confirm)
// come from simranjeetc/opencode-handoff-on-context. What changed: the
// trigger runs outside the agents, the handoff is written by the agent
// itself, and any supported agent kind can be handed off.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readContext, SUPPORTED_KINDS } from "./readers.js";

const HOME = homedir();
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = {
  // Claude Code auto-compacts a 200k window at roughly 167k, so trigger earlier.
  claude: 150_000,
  codex: 170_000,
  opencode: 170_000,
  pi: 170_000,
};

function num(env, name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function flag(env, name) {
  return ["1", "true", "yes", "on"].includes(String(env[name] ?? "").trim().toLowerCase());
}

export function loadConfig(env = process.env) {
  const globalThreshold = num(env, "HERDR_HANDOFF_THRESHOLD", 0);
  const thresholds = {};
  for (const kind of SUPPORTED_KINDS) {
    thresholds[kind] = num(env, `HERDR_HANDOFF_THRESHOLD_${kind.toUpperCase()}`, globalThreshold || DEFAULT_THRESHOLDS[kind]);
  }
  const kinds = (env.HERDR_HANDOFF_KINDS || SUPPORTED_KINDS.join(","))
    .split(",")
    .map((k) => k.trim())
    .filter((k) => SUPPORTED_KINDS.includes(k));
  const handoffDir = env.HERDR_HANDOFF_DIR || join(HOME, "agent-shared", "handoffs");
  return {
    thresholds,
    kinds,
    handoffDir,
    skillPath: env.HERDR_HANDOFF_SKILL || join(HOME, "agent-shared", "skills", "handoff", "SKILL.md"),
    session: env.HERDR_HANDOFF_SESSION || "",
    intervalMs: num(env, "HERDR_HANDOFF_INTERVAL_MS", 20_000),
    writeTimeoutMs: num(env, "HERDR_HANDOFF_WRITE_TIMEOUT_MS", 600_000),
    confirmTimeoutMs: num(env, "HERDR_HANDOFF_CONFIRM_TIMEOUT_MS", 60_000),
    splitDirection: env.HERDR_HANDOFF_SPLIT_DIRECTION || "right",
    keepOld: flag(env, "HERDR_HANDOFF_KEEP_OLD"),
    dryRun: flag(env, "HERDR_HANDOFF_DRY_RUN"),
    statePath: env.HERDR_HANDOFF_STATE || join(HOME, ".local", "state", "herdr-handoff", "state.json"),
    logPath: env.HERDR_HANDOFF_LOG || join(HOME, ".local", "state", "herdr-handoff", "watch.log"),
  };
}

// ---------------------------------------------------------------------------
// Logging + state
// ---------------------------------------------------------------------------

export function makeLogger(logPath) {
  const write = (level, msg, fields) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields || {}) });
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + "\n");
    } catch {
      // logging is best-effort
    }
    (level === "error" || level === "warn" ? console.error : console.log)(line);
  };
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { triggered: {} };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// herdr CLI
// ---------------------------------------------------------------------------

// Returns {code, stdout, stderr, json}. Never throws.
export function makeHerdr(session = "") {
  const prefix = session ? ["--session", session] : [];
  return (args, timeoutMs = 120_000) =>
    new Promise((resolve) => {
      execFile("herdr", [...prefix, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(stdout);
        } catch {
          try {
            json = JSON.parse(stderr);
          } catch {
            json = undefined;
          }
        }
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
      });
    });
}

// ---------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------

export function sessionKey(agent) {
  const s = agent?.agent_session;
  return s?.value ? `${agent.agent}:${s.value}` : undefined;
}

// Why an agent is not a candidate, or undefined when it is one.
export function skipReason(agent, config, state) {
  if (!config.kinds.includes(agent?.agent)) return "kind not watched";
  if (!["idle", "done"].includes(agent?.agent_status)) return `status ${agent?.agent_status}`;
  const key = sessionKey(agent);
  if (!key) return "no session reported";
  if (state.triggered[key]) return "already handed off";
  return undefined;
}

export function parseHandoffPath(text) {
  const matches = [...String(text).matchAll(/HANDOFF:\s*`?(\/[^\s`]+\.md)`?/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

export function newestHandoffSince(dir, sinceMs) {
  if (!existsSync(dir)) return undefined;
  let best;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    const mtime = statSync(full).mtimeMs;
    if (mtime >= sinceMs && (!best || mtime > best.mtime)) best = { full, mtime };
  }
  return best?.full;
}

export function nextAgentName(agent, existingNames) {
  const base = (agent.name || `${agent.agent}`).replace(/-h\d+$/, "").replace(/-old$/, "");
  for (let i = 2; ; i++) {
    const name = `${base}-h${i}`;
    if (!existingNames.has(name)) return name;
  }
}

export function writePrompt({ agent, tokens, config, cwd }) {
  const how = existsSync(config.skillPath)
    ? `Read ${config.skillPath} and follow it to write a handoff document.`
    : "Write a handoff document: goal, current state, decisions and why, files touched, failed attempts, next concrete steps. Redact secrets.";
  return [
    `Your context is at about ${Math.round(tokens / 1000)}k tokens, so this session now hands off to a fresh ${agent.agent} session.`,
    how,
    `The next session continues this same work in ${cwd}.`,
    `Save the document in ${config.handoffDir}/ and do not change any other files.`,
    `End your reply with one line exactly like: HANDOFF: <absolute path of the file>`,
  ].join(" ");
}

export function resumePrompt(path) {
  return `Automatic context handoff from a previous session of this agent. Read ${path} first: it is your context. Then continue the work from the next concrete step it names. Do not ask the user to repeat anything.`;
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

// `agent wait` fails fast with agent_not_found while the new agent is still
// registering, so retry short slices until the deadline (from the original).
export async function confirmWorking(herdr, target, timeoutMs, sleep = sleepMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = Math.min(5000, Math.max(200, deadline - Date.now()));
    const r = await herdr(["agent", "wait", target, "--until", "working", "--timeout", String(slice)], slice + 5000);
    if (r.code === 0) return true;
    await sleep(300);
  }
  return false;
}

export async function handoff({ agent, tokens, config, herdr, log, existingNames, now = Date.now, sleep = sleepMs }) {
  const oldPane = agent.pane_id;
  const target = agent.name || oldPane;
  const cwd = agent.foreground_cwd || agent.cwd || HOME;
  const startedAt = now();
  mkdirSync(config.handoffDir, { recursive: true });

  // 1. Ask the old agent to write the handoff.
  log.info("asking agent to write handoff", { target, kind: agent.agent, tokens });
  const asked = await herdr(["agent", "prompt", target, writePrompt({ agent, tokens, config, cwd }), "--wait", "--timeout", String(config.writeTimeoutMs)], config.writeTimeoutMs + 10_000);
  const status = asked.json?.result?.agent?.agent_status;
  if (asked.code !== 0 || status === "blocked") {
    return { ok: false, step: "write", detail: (asked.stderr || asked.stdout).slice(0, 300) || `status ${status}` };
  }

  // 2. Find the file: the printed HANDOFF line first, then the newest new file.
  const read = await herdr(["agent", "read", target, "--source", "recent-unwrapped", "--lines", "200"]);
  let path = parseHandoffPath(read.stdout);
  if (!path || !existsSync(path)) path = newestHandoffSince(config.handoffDir, startedAt - 1000);
  if (!path || !existsSync(path) || statSync(path).size < 200) {
    return { ok: false, step: "find-file", detail: `no handoff file found (parsed: ${path ?? "none"})` };
  }
  log.info("handoff written", { target, path });

  // 3. New pane + same agent kind.
  const split = await herdr(["pane", "split", oldPane, "--direction", config.splitDirection, "--cwd", cwd, "--no-focus"]);
  const newPane = split.json?.result?.pane?.pane_id;
  if (!newPane) return { ok: false, step: "split", path, detail: (split.stderr || split.stdout).slice(0, 300) };
  const newName = nextAgentName(agent, existingNames);
  const started = await herdr(["agent", "start", newName, "--kind", agent.agent, "--pane", newPane, "--timeout", "60000"], 90_000);
  if (started.code !== 0) {
    return { ok: false, step: "start", path, newPane, detail: (started.stderr || started.stdout).slice(0, 300) };
  }

  // 4. Hand over the file and confirm the new agent took it.
  await herdr(["agent", "prompt", newName, resumePrompt(path)]);
  const confirmed = await confirmWorking(herdr, newName, config.confirmTimeoutMs, sleep);
  if (!confirmed) {
    return { ok: false, step: "confirm", path, newPane, newName, detail: "new agent never reported working; old pane kept" };
  }

  // 5. Retire the old session.
  if (config.keepOld) {
    if (agent.name) await herdr(["agent", "rename", target, `${agent.name.replace(/-h\d+$/, "")}-old`]);
  } else {
    await herdr(["pane", "close", oldPane]);
  }
  await herdr(["notification", "show", `Handoff: ${target} -> ${newName}`, "--body", path, "--sound", "done"]);
  return { ok: true, path, newPane, newName, oldClosed: !config.keepOld };
}

// ---------------------------------------------------------------------------
// One poll
// ---------------------------------------------------------------------------

export async function pollOnce({ config, herdr, log, state, read = readContext, doHandoff = handoff }) {
  const listed = await herdr(["agent", "list"]);
  const agents = listed.json?.result?.agents;
  if (!Array.isArray(agents)) {
    return { error: (listed.stderr || listed.stdout || "agent list failed").slice(0, 200), rows: [] };
  }
  const names = new Set(agents.map((a) => a.name).filter(Boolean));
  const rows = [];
  for (const agent of agents) {
    let tokens;
    try {
      tokens = await read(agent);
    } catch (error) {
      log.warn("could not read context", { pane: agent.pane_id, kind: agent.agent, error: String(error?.message ?? error) });
    }
    const threshold = config.thresholds[agent.agent];
    const row = { pane: agent.pane_id, name: agent.name, kind: agent.agent, status: agent.agent_status, tokens, threshold };
    rows.push(row);
    const reason = skipReason(agent, config, state);
    if (reason || tokens === undefined || tokens < threshold) continue;

    row.action = config.dryRun ? "would-handoff" : "handoff";
    if (config.dryRun) {
      log.info("dry run: would hand off", row);
      continue;
    }
    const key = sessionKey(agent);
    state.triggered[key] = { at: new Date().toISOString(), pane: agent.pane_id, tokens };
    saveState(config.statePath, state);
    const result = await doHandoff({ agent, tokens, config, herdr, log, existingNames: names });
    state.triggered[key].result = result;
    saveState(config.statePath, state);
    (result.ok ? log.info : log.error)("handoff finished", { pane: agent.pane_id, kind: agent.agent, ...result });
    if (result.newName) names.add(result.newName);
  }
  return { rows };
}

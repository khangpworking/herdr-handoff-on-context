#!/usr/bin/env node
// herdr-handoff-watch: hand agents off to a fresh session before their context fills.
//
//   herdr-handoff-watch            poll forever (use as a service)
//   herdr-handoff-watch status     print each agent's context size once
//   herdr-handoff-watch once       one poll, handing off where needed
//   herdr-handoff-watch reset      forget which sessions were already handed off

import { loadConfig, loadState, saveState, makeHerdr, makeLogger, pollOnce } from "../src/watch.js";

const config = loadConfig();
const log = makeLogger(config.logPath);
const herdr = makeHerdr(config.session);
const cmd = process.argv[2] || "watch";

function printRows(rows) {
  for (const r of rows) {
    const k = r.tokens === undefined ? "?" : `${Math.round(r.tokens / 1000)}k`;
    const t = r.threshold ? `${Math.round(r.threshold / 1000)}k` : "-";
    console.log(`${(r.name || r.pane).padEnd(16)} ${String(r.kind).padEnd(9)} ${String(r.status).padEnd(8)} ${k.padStart(6)} / ${t}${r.action ? "  <- " + r.action : ""}`);
  }
}

if (cmd === "reset") {
  saveState(config.statePath, { triggered: {} });
  console.log(`cleared ${config.statePath}`);
} else if (cmd === "status") {
  const res = await pollOnce({ config: { ...config, dryRun: true }, herdr, log: { info() {}, warn() {}, error() {} }, state: loadState(config.statePath) });
  if (res.error) console.error(res.error);
  printRows(res.rows);
} else if (cmd === "once") {
  const res = await pollOnce({ config, herdr, log, state: loadState(config.statePath) });
  if (res.error) console.error(res.error);
  printRows(res.rows);
} else if (cmd === "watch") {
  log.info("watch started", { session: config.session || "default", thresholds: config.thresholds, kinds: config.kinds, keepOld: config.keepOld, dryRun: config.dryRun });
  let lastError = "";
  for (;;) {
    try {
      const res = await pollOnce({ config, herdr, log, state: loadState(config.statePath) });
      // herdr server down is normal (no session open); log it once, not every poll.
      if (res.error && res.error !== lastError) log.warn("agent list failed", { error: res.error });
      lastError = res.error || "";
    } catch (error) {
      log.error("poll crashed", { error: String(error?.stack ?? error) });
    }
    await new Promise((r) => setTimeout(r, config.intervalMs));
  }
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

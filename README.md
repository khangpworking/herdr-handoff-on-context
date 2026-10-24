# herdr-handoff-on-context

Watches every agent running in [Herdr](https://herdr.dev) and, when one gets close to a full context window, hands it off to a **fresh session of the same agent**. You get a new session instead of an auto-compacted one.

Supported agents: **Claude Code, Codex, OpenCode (v1), pi**.

> Fork of [simranjeetc/opencode-handoff-on-context](https://github.com/simranjeetc/opencode-handoff-on-context) (MIT, archived), which did this for OpenCode only, as an in-process plugin. This fork keeps its Herdr steps but runs outside the agents, so it works for any agent Herdr knows.

## How it works

Every 20 s the watcher runs `herdr agent list`. For each agent that is **idle** and has a reported session:

1. It reads the agent's current context size from the agent's own session file:

   | Agent | Source (from Herdr's `agent_session`) | Context = |
   |---|---|---|
   | claude | transcript `.jsonl` | input + cache read + cache write + output of the last main-thread reply |
   | codex | rollout `.jsonl` | `last_token_usage` input + output of the last `token_count` event |
   | pi | session `.jsonl` | input + output + cacheRead + cacheWrite of the last assistant reply |
   | opencode | `~/.local/share/opencode/opencode.db` | the original plugin's formula, last assistant message |

2. When it reaches the threshold, the watcher asks the agent to write a handoff document with the shared handoff skill (`~/agent-shared/skills/handoff/SKILL.md`, if present) into `~/agent-shared/handoffs/`, ending with `HANDOFF: <path>`.
3. It splits the agent's pane, starts the same agent kind there (`herdr agent start <name>-h2 --kind <kind>`), and tells it to read the handoff file and continue.
4. When the new agent is confirmed `working`, the old pane is closed (or kept, renamed `<name>-old`, with `HERDR_HANDOFF_KEEP_OLD=1`). A Herdr notification shows the switch.

Safety rules:
- It never interrupts a running turn. It only acts on `idle`/`done` agents.
- It never answers approval dialogs. If the agent gets `blocked` while writing, the handoff stops and nothing is closed.
- It hands off each session only once (state in `~/.local/state/herdr-handoff/state.json`). Run `reset` to clear that state.
- If the new agent does not start working, the old pane stays open.

## Install (Fedora / Linux)

Requires Node >= 22.13 (for `node:sqlite`, used for OpenCode), `herdr` on PATH, and the Herdr integrations for your agents (`herdr integration install claude|codex|opencode|pi`). The integrations report the session path to Herdr.

```bash
git clone https://github.com/khangpworking/herdr-handoff-on-context ~/herdr-handoff-on-context
node ~/herdr-handoff-on-context/bin/herdr-handoff-watch.js status   # see context per agent
cp ~/herdr-handoff-on-context/systemd/herdr-handoff-watch.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now herdr-handoff-watch
```

Commands: `watch` (default, loop), `status` (print context per agent), `once` (one poll), `reset`.

## Settings (environment variables)

| Variable | Default |
|---|---|
| `HERDR_HANDOFF_THRESHOLD` | per kind: claude 150000 (Claude auto-compacts a 200k window near 167k), others 170000 |
| `HERDR_HANDOFF_THRESHOLD_CLAUDE` / `_CODEX` / `_OPENCODE` / `_PI` | override for one kind |
| `HERDR_HANDOFF_KINDS` | `claude,codex,opencode,pi` |
| `HERDR_HANDOFF_KEEP_OLD` | off: close the old pane after the new one works |
| `HERDR_HANDOFF_DIR` | `~/agent-shared/handoffs` |
| `HERDR_HANDOFF_SKILL` | `~/agent-shared/skills/handoff/SKILL.md` |
| `HERDR_HANDOFF_SESSION` | Herdr's default session |
| `HERDR_HANDOFF_INTERVAL_MS` | 20000 |
| `HERDR_HANDOFF_WRITE_TIMEOUT_MS` | 600000 |
| `HERDR_HANDOFF_SPLIT_DIRECTION` | `right` |
| `HERDR_HANDOFF_DRY_RUN` | off |
| `HERDR_HANDOFF_LOG` | `~/.local/state/herdr-handoff/watch.log` |

## Agent quirks handled

- **Claude** reports a session **id** to Herdr; the watcher finds the transcript under `~/.claude/projects/`.
- **Codex** does not run Herdr's `SessionStart` hook until you approve it in Codex's hook-review screen, so Herdr may have no session for it. The watcher then matches the rollout header (same cwd, started after the pane's `codex` process). It skips the match when two Codex agents share a cwd.
- **Codex review screen** swallows typed prompts. The watcher presses **Esc** (it never trusts a hook) until the input box is back.
- **Confirmation**: a handoff counts only when the handoff file name shows up in the new agent's transcript. Herdr's `working` state alone was wrong once in testing. The prompt is resent once if needed.

Tested live on herdr 0.9.5 with claude 2.1.309, codex 0.164.0, opencode 1.19.4 and pi 1.4.0: all four handed off, and each new session recalled a codeword that only the old session had.

## Limits

- The new session starts with the agent's **default** model and flags, not what you switched to mid-session.
- Agents must be able to write to the handoff dir without an approval prompt (bypass mode, or allow that folder). Otherwise the write step blocks and the handoff stops.
- OpenCode v2 changed its storage. Only v1 is supported for OpenCode.

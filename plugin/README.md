# Golem Studio plugin source

The plugin is a single `Script` (`VERSION = "4.1.0"` inside `Golem.lua`).

- `Golem.lua` — the canonical source. Edit this, then rebuild the model file.
- `Golem.rbxmx` — the installable build: one top-level `Script` named
  `Golem`, `Disabled=false`, with the Lua source in `Source`. Attach this
  file to each GitHub Release; it is also what gets uploaded to the Roblox
  Creator Store.
- `build.py` — wraps `Golem.lua` in the `.rbxmx` XML envelope and
  round-trip-verifies it (`python3 build.py`, needs only the standard library).

## Testing the plugin without Studio

`test/plugin/` boots the real `Golem.lua` inside
[fengari](https://github.com/fengari-lua/fengari) (Lua 5.3 in JS) against a
Roblox shim, pushes commands through a fake Firebase relay, and drives the
panel's buttons. It is what catches UI and relay bugs that reading cannot.

```sh
npm install --no-save fengari
node test/plugin/run.js          # all four suites
node test/plugin/run.js sweep    # one suite: ui | switch | restart | sweep
node test/plugin/lint.js plugin/Golem.lua
```

- `ui` — the setup window: close hides it, COPY copies without stealing focus,
  the line is not editable, ASK YOUR AI acts, the switch persists.
- `switch` — off really stops commands, rotates the channel, and on resumes.
- `restart` — a saved OFF survives a reload with zero polls.
- `sweep` — every op is driven in the correct phase and must return a result.

`fengari` is installed on demand rather than listed as a dependency, so plain
`npm test` (the CLI suite) stays dependency-free. The shim is deliberately
strict: it raises on unknown UI properties and on writing to
`HttpService.HttpEnabled`, because a permissive shim hides exactly the bugs
this is meant to find.

Install: drop `Golem.rbxmx` into Studio's `Plugins` folder and restart Studio.

**One setting must be on first:** `Game Settings > Security > Allow HTTP
Requests`. A fresh place has it off, and without it the plugin cannot reach the
relay at all. If it is off the panel says so in its status line rather than
sitting on "connecting" forever.

## What changed in 4.1.0
- **Code execution in the test.** `lua --target server|client`, plus
  `run_script` / `run_list` / `run_remove`. The server runs inline; the client
  has no `loadstring` in Roblox at all, so a client snippet is installed as a
  `RunContext = Client` Script and its output arrives through `logs`.
- **Honest input.** A rejected click or key press now fails with the reason; a
  hold whose release fails says the key is still held. Holding works at all:
  `input --hold w --hold-seconds 2`.
- **Screenshots that fit.** The capture width is derived from the worst case
  (17 B/px) and is both the default and the ceiling, so a capture cannot be
  rejected in transit. 522px.
- **First run names its blocker.** With Allow HTTP Requests off the panel shows
  `BLOCKED · turn on Allow HTTP Requests (Game Settings > Security)` instead of
  an unexplained CONNECTING.
- **A switch that actually switches.** Settings now starts with a master
  switch. Off stops the relay loop, rotates the channel, and retires the old
  one, so a line you already pasted into a chat stops working; a saved OFF
  survives a Studio restart. On mints a fresh channel and resumes.
- **The setup window behaves.** Close dismisses the popup (the SET UP AI pill
  reopens it); COPY copies and nothing else — it no longer steals focus or
  moves the cursor; the line itself is selectable but not editable, because an
  edited line is a broken line; and ASK YOUR AI now puts the line on the
  clipboard instead of being a button that did nothing.

## What changed in 4.0.0 adds code execution inside the running test, honest input reporting,
screenshots that fit the relay, and the first-run HTTP warning described below.)

- **Relay transport.** Studio can only make outgoing calls and the AI is often a
  cloud sandbox, so both meet at a Firebase Realtime Database:
  `channels/<id>/cmd`, `/res`, `/beacons`. The plugin polls for new command keys,
  deletes each one it handled, and ignores anything older than the moment its
  session started. The window shows one setup line
  (`npx golem-bridge connect <channelId>`) that works from any machine.
- **Session capability.** The 16-hex channel id is minted per Studio session,
  kept in memory only (an id persisted by an older build is wiped on load), and
  replaced on END SESSION — the old channel is marked `revoked` and deleted.
- **Reverts work.** Every AI tool call runs inside a named
  `ChangeHistoryService` recording, so one Undo in Studio reverts exactly one
  tool call instead of a vague waypoint sprawl.
- **Real playtesting.** `play` starts an actual Studio test session and injects
  a driver into the running game, which is what makes `screenshot`, `click`,
  `input`, `look_through`, and in-game `logs` possible.
- **Tool history only.** The note system is gone. The panel is a numbered
  timeline: `Turn: N` with one row per tool call. A turn opens on the first call
  of a request and needs no closing message.
- **Layout fixes.** Row detail panels live inside their row, so an expanded
  error can no longer slide under the header.

# Golem

`golem-bridge` connects an AI coding agent to a live Roblox Studio session
running the Golem plugin.

This repo holds the npm package (the AI side) and the Studio plugin source
(`plugin/Golem.lua`). The built plugin (`plugin/Golem.rbxmx`) is attached
to each GitHub Release and distributed through the Roblox Creator Store.

## How it connects

A small Firebase Realtime Database relay sits between Studio and the AI. Not
because a relay is nice to have, but because of two hard facts:

- a Studio plugin can only make **outgoing** HTTP calls, and
- the AI running `golem-bridge` is often a **cloud sandbox** that cannot reach
  your computer at all.

So both sides meet in the middle. `golem-bridge` pushes a command into a channel
and Studio polls that channel, runs the command, and pushes the result back. The
database only stores JSON — it knows nothing about Roblox and never sees a token.

Studio shows one line in the Golem window (and in Settings):

```
npx golem-bridge connect 9f3c1a77b0e24d58
```

Paste it into **any** AI chat. `connect` pings the channel, saves the id to
`./.golem/link.json`, and prints the tool manual:

```sh
npx golem-bridge ping
npx golem-bridge tree --depth 3
```

`ping` returns `"ok": true` plus the open place name. `manual` reprints the
reference any time (`help <tool>` explains one tool). Each tool reply also
carries the turn it landed in, which is the number drawn in the Studio window.

If a call looks stuck, `status` reads the channel beacons and says which of these
happened: Studio stopped polling, the plugin is an old build, or that line is
from a Studio session that has since rotated.

Done with a session? Forget it locally (Studio is unaffected):

```sh
npx golem-bridge disconnect
```

## Who this is for

Any AI you can paste text into — **including agents with no MCP support**, and
agents that run somewhere other than your PC. Roblox's built-in MCP server is
stdio-only (there is no local port to connect to), and a cloud session cannot
start it, so the same limit hits every remote agent.

Golem works the other way around: the setup line is the only thing the AI needs,
and it works from a laptop, a container, or a hosted sandbox.

### The security model, in one paragraph

The **channel id is the capability**. It is 16 random hex characters, minted for
each Studio session, held only in memory, and never written to disk. Ending the
session (or restarting Studio) mints a new one, marks the old channel `revoked`,
and deletes it — so a line you pasted into a chat transcript is dead the moment
the session it names is over. Anyone who holds a live line and reaches the relay
can drive that Studio session; that is the whole trust model, and it is why the
line expires.

## What the AI can do

- **Build and edit**: create parts, scripts, UI, terrain, lights, sounds; move,
  rotate, scale, group, weld, paint; search the Creator Store and insert assets.
- **Read**: list, tree, find, grep, count, read script source, run Luau.
- **Revert**: every AI change is one named undo step in Studio's own history, so
  Ctrl+Z reverts exactly one tool call. `undo --times N` / `redo` do it from the
  terminal.
- **Play the game**: `play` starts a real Studio test session and injects a
  driver into it, so the AI can `screenshot` (PNG on disk), `click`, `input`
  keys, aim the camera, and read the in-game `logs`.

The Studio window shows a numbered timeline — `Turn: 1`, one row per tool call,
click a row for the request, result, and the instances it touched. There are no
notes: the turn counter is the whole bookkeeping.

## Files

- `cli.js` — the whole package: relay transport, session setup, every Studio tool
- `golem-tools.md` — the agent manual (printed by `connect` and `manual`)
- `plugin/Golem.lua` — the Studio plugin source
- `plugin/Golem.rbxmx` — the installable plugin build (`python3 plugin/build.py`)
- `package.json` — npm manifest

## Notes

- Commands travel through the relay channel; Studio results travel back the same
  way. Nothing else leaves the machine, except marketplace lookups, which talk to
  roblox.com from this terminal because Studio cannot.
- The plugin deletes each command from the channel after running it and ignores
  anything older than the moment its current session started, so a command queued
  for a closed Studio never fires into the next one.
- npm account `skellzy` and GitHub `nickils` are the same person.

## Environment variables (all optional)

- `GOLEM_FIREBASE_DB` — the relay base URL (default
  `https://roblox-golem-default-rtdb.firebaseio.com`). Must be `https://`, except
  for a local emulator on `127.0.0.1`.
- `GOLEM_CHANNEL` — use this channel id instead of `./.golem/link.json` (useful
  when a script or a fresh sandbox must pin a session).
- `GOLEM_POLL_INTERVAL` — seconds between result polls in the CLI (default `2`).
- `GOLEM_TURN_IDLE` — seconds of quiet after which the next tool call starts a
  new turn in the Studio timeline (default 300).

## Security

- `connect` only accepts a hex channel id, verifies the round trip before saving,
  and writes the link file with the id and nothing else.
- Studio mints the channel in memory, wipes any id an older build persisted, and
  refuses edit commands while a play test is running.
- `status` never talks to Studio; it reads the beacons, so it cannot be used to
  poke a session that has ended.
- Scanners flag the Lua execution and editing commands. That is what Golem is:
  your agent driving your own Studio. The session channel is the whole security
  model.

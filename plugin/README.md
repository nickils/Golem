# Golem Studio plugin source

The plugin is a single `Script` (`VERSION = "4.0.0"` inside `Golem.lua`).

- `Golem.lua` — the canonical source. Edit this, then rebuild the model file.
- `Golem.rbxmx` — the installable build: one top-level `Script` named
  `Golem`, `Disabled=false`, with the Lua source in `Source`. Attach this
  file to each GitHub Release; it is also what gets uploaded to the Roblox
  Creator Store.
- `build.py` — wraps `Golem.lua` in the `.rbxmx` XML envelope and
  round-trip-verifies it (`python3 build.py`, needs only the standard library).

Install: drop `Golem.rbxmx` into Studio's `Plugins` folder and restart Studio.

## What changed in 4.0.0

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

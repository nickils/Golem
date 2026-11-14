# Golem

`golem-bridge` connects an AI coding agent to a live Roblox Studio session
running the Golem plugin.

This repo holds the npm package (the AI side) and the Studio plugin source
(`plugin/Golem.lua`). The built plugin (`plugin/Golem.rbxmx`) is attached
to each GitHub Release and distributed through the Roblox Creator Store.

## How it connects

No relay. The plugin in Studio talks to `golem-bridge` on **your computer**,
over `127.0.0.1:41717`. Studio plugins are allowed to reach localhost, so the
command path is: AI terminal → plugin → Studio, and back. Nothing is routed
through a third-party service, there is no channel id to leak, and the link
dies when you close Studio or run `disconnect`.

Studio shows one line in the Golem window (and in Settings):

```
npx golem-bridge connect <inbox>:<secret>
```

Run it once in the AI's terminal. It verifies the round trip, saves
`./.golem/link.json` (mode `0600`), starts a small background bridge so later
tool calls do not have to re-link, and prints the tool manual.

```sh
npx golem-bridge ping
npx golem-bridge tree --depth 3
```

`ping` returns `"ok": true` plus the open place name. `manual` reprints the
reference any time (`help <tool>` explains one tool). Each tool reply also
carries the turn it landed in, which is the number drawn in the Studio window.

Done with a session? Forget it locally (Studio is unaffected):

```sh
npx golem-bridge disconnect
```

## What the AI can do

- **Build and edit**: create parts, scripts, UI, terrain, lights, sounds; move,
  rotate, scale, group, weld, paint; search the Creator Store and insert assets.
- **Read**: list, tree, find, grep, count, read script source, run Luau.
- **Revert**: every AI change is one named undo step in Studio's own history, so
  Ctrl+Z reverts exactly one tool call. `undo --times N` / `redo` do it from the
  terminal.
- **Play the game**: `play` starts a real Studio test session and injects a
  driver into it, so the AI can `screenshot` (PNG on disk), `click`, `input`
  keys, aim the camera, and read the in-game `logs`. That is what makes it able
  to test what it built instead of guessing.

The Studio window shows a numbered timeline — `Turn: 1`, one row per tool call,
click a row for the request, result, and the instances it touched. There are no
notes: the turn counter is the whole bookkeeping.

## Files

- `cli.js` - the whole package: local bridge, session setup, every Studio tool
- `golem-tools.md` - the agent manual (printed by `connect` and `manual`)
- `plugin/Golem.lua` - the Studio plugin source
- `plugin/Golem.rbxmx` - the installable plugin build (`python3 plugin/build.py`)
- `package.json` - npm manifest

## Notes

- Only `cli.js`, `golem-tools.md`, and (via `connect`) the local link file are
  used. No data leaves the machine except the marketplace lookups, which talk to
  roblox.com from this terminal because Studio cannot.
- The bridge listens on loopback only and requires the secret from the setup
  line on every call. A different Studio window on the same port is refused.
- npm account `skellzy` and GitHub `nickils` are the same person.

## Environment variables (all optional)

- `GOLEM_PORT` — bridge port (default `41717`). Set it when two projects need
  separate sessions at the same time.
- `GOLEM_DEVICE` — `device:secret` override, for scripted setups.
- `GOLEM_TURN_IDLE` — seconds of quiet after which the next tool call starts a
  new turn in the Studio timeline (default 300).

## Security

Trust model: the setup line is the capability. Anyone holding it and able to
reach this machine's loopback port could drive that Studio session. It stays
valid until the user ends the session in Studio, which mints a new one.

- `connect` only accepts the documented line format, verifies the round trip
  before saving, writes the link file `0600`, and never sends the secret
  anywhere except `127.0.0.1`.
- The plugin talks only to `127.0.0.1` and sends the secret as a header. It
  refuses commands from a bridge with a different secret.
- Scanners flag the Lua execution and editing commands. That is what Golem is:
  your agent driving your own Studio. The session secret is the whole security
  model.

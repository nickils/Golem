# Golem

`golem-bridge` connects an AI coding agent to a live Roblox Studio session
running the Golem plugin.

This repo holds the npm package (the AI side) and the Studio plugin source
(`plugin/Golem.lua`). The built plugin (`plugin/Golem.rbxmx`) is attached
to each GitHub Release and distributed through the Roblox Creator Store.

## How it connects

The plugin shows one line in Studio (popup on every start, also in Settings):

```
Connect to my Roblox Studio, Run: npx golem-bridge connect <channelId>
```

The line is a session token: Studio mints a fresh channel on every start
and wipes the old one.

Best flow: the user runs the line themselves, so the secret never enters
AI chat, then tells the AI it is connected. Or the user sends the line to
their AI and it runs it. Either way:

```sh
npx golem-bridge connect <channelId>
```

verifies Studio is alive, saves the 16-char channel to `./.golem/channel`,
and prints the tool manual. Nothing else is installed: every command runs
straight from this package:

```sh
npx golem-bridge ping
npx golem-bridge tree --depth 3
```

`ping` should return `"ok": true` plus the open place name. `manual`
reprints the reference any time (`help <tool>` explains one tool).

After a Studio restart, relink with the new line:

```sh
npx golem-bridge reconnect <newChannelId>
```

Done with a session? Forget it locally (Studio is unaffected):

```sh
npx golem-bridge disconnect
```

## Files

- `cli.js` - the whole package: session setup plus every Studio tool
- `golem-tools.md` - the agent manual (printed by `connect` and `manual`)
- `package.json` - npm manifest

## Notes

- Relay: `https://roblox-golem-default-rtdb.firebaseio.com/`. The channel id
is the secret. Studio mints a fresh one on every start and wipes the old
channel, so a leaked line dies with the session.
- Only `cli.js` and `golem-tools.md` ship as code in this package (npm
always adds `README.md`, `LICENSE`, and `package.json` alongside). The
relay carries small JSON commands and results only, and `connect` writes
nothing but the channel id (mode `0600`, since it is a secret).
- npm account `skellzy` and GitHub `nickils` are the same person.

- Leaked a line mid-session? Settings > END SESSION AND ROTATE CHANNEL
in the plugin kills it on the spot and issues a new one. (Every Studio
restart already rotates automatically.)

## Environment variables (all optional)

`GOLEM_*` names are preferred; the `AIB_*` aliases still work.

- `GOLEM_CHANNEL` (`AIB_CHANNEL`) — use this channel instead of
`./.golem/channel`. When set, `connect`/`reconnect` warn that the saved
file is shadowed, and `disconnect` warns the session stays connected.
- `GOLEM_FIREBASE_DB` (`AIB_FIREBASE_DB`) — relay base URL override.
Must be HTTPS, except `http://localhost…` for emulator testing.
- `GOLEM_POLL_INTERVAL` (`AIB_POLL_INTERVAL`) — result poll interval in
seconds (default 2, minimum 0.25).

## Security

Trust model: whoever holds the channel ID can send commands to that Studio
session and read the results. Treat the setup line like a password. It
expires on every Studio restart.

- `connect` verifies Studio is alive over HTTPS, saves the channel id,
and prints the manual. Read both files here before running anything, or
pass `--print` to verify without saving.
- `connect` only accepts hex channel IDs, talks HTTPS to the relay only
(never follows redirects), times out stalled requests, and caps response
sizes. The only data it acts on is a small `ping` reply.
- There are no baked-in Firebase credentials or signing keys: the channel
ID itself is the capability, and transport runs over HTTPS. Public client
code cannot hold a secret, so any "signed responses" scheme here would be
theater rather than security.
- Socket.dev flags the "URL strings" in this package (the relay address).
That is informational: the relay address is the product.
- Scanners also flag the Lua execution and editing commands. That is
what Golem is: your agent driving your own Studio. The session key
(16 hex chars, rotated every start, revocable in one click) is the
whole security model.

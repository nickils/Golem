# Golem

`golem-bridge` connects an AI coding agent to a live Roblox Studio session
running the Golem plugin.

This repo holds the npm package (the AI side). The Studio plugin itself is
distributed through the Roblox Creator Store, not from here.

## How it connects

The plugin shows one line in Studio (popup on every start, also in Settings):

```
Connect to my Roblox Studio, Run: npx golem-bridge connect <channelId>
```

The line is a session token: Studio mints a fresh channel on every start
and wipes the old one.

The user sends that line to their AI. It downloads this package, which
checks Studio is alive, then stamps the channel into local copies of
the two connection files under `./.golem/`:

```sh
npx golem-bridge connect <channelId>
python3 ./.golem/golem.py ping
```

`ping` should return `"ok": true` plus the open place name. Then the agent
reads `./.golem/golem.md` for the full tool reference.

After a Studio restart, relink with the new line:

```sh
npx golem-bridge reconnect <newChannelId>
```

Done with a session? Forget it locally (Studio is unaffected):

```sh
npx golem-bridge disconnect
```

## Files

- `cli.js` - source of the `golem-bridge` package
- `golem.py` - the Studio helper, stamped with the channel at connect
- `golem.md` - the agent manual
- `firebase-rules.json` - relay rules (paste into the Firebase console once)
- `package.json` - npm manifest

## Notes

- Relay: `https://roblox-golem-default-rtdb.firebaseio.com/`. The channel id
is the secret. Studio mints a fresh one on every start and wipes the old
channel, so a leaked line dies with the session.
- `golem.py` and `golem.md` ship in this package. The relay carries
small JSON commands and results only.
- Relay rules: paste `firebase-rules.json` into the Firebase console
(Realtime Database > Rules) once. It lets anyone open a channel they
know the ID of, and nobody list channels. All three programs only ever
touch their own channel, so nothing else changes.
- Leaked a line mid-session? Settings > END SESSION AND ROTATE CHANNEL
in the plugin kills it on the spot and issues a new one. (Every Studio
restart already rotates automatically.)

## Security

Trust model: whoever holds the channel ID can send commands to that Studio
session and read the results. Treat the setup line like a password. It
expires on every Studio restart.

- `connect` verifies
Studio is alive over HTTPS and stamps your channel ID into local copies.
Read all three files here before running anything, or fetch with
`--print` to inspect without writing.
- `connect` asks before it writes: it lists the files first, then waits
for y. Pass `--yes` to skip the question (scripts), `--print` to look
without writing.
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

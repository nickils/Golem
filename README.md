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

The user sends that line to their AI. It downloads this package, which asks
the plugin for its two connection files and stores them under `./.golem/`:

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
- `package.json` - npm manifest

## Notes

- Relay: `https://roblox-golem-default-rtdb.firebaseio.com/`. The channel id
is the secret. Studio mints a fresh one on every start and wipes the old
channel, so a leaked line dies with the session.
- The plugin serves `golem.py` and `golem.md` on demand. They are never
stored on the relay.

## Security

Trust model: whoever holds the channel ID can send commands to that Studio
session and read the results. Treat the setup line like a password. It
expires on every Studio restart.

- `connect` verifies
Studio is alive over HTTPS and stamps your channel ID into local copies.
Read all three files here before running anything, or fetch with
`--print` to inspect without writing.
- `connect` only accepts hex channel IDs, talks HTTPS to the relay only
(never follows redirects), times out stalled requests, and caps response
sizes. The only data it acts on is a small `ping` reply.
- There are no baked-in Firebase credentials or signing keys: the channel
ID itself is the capability, and transport runs over HTTPS. Public client
code cannot hold a secret, so any "signed responses" scheme here would be
theater rather than security.
- Socket.dev flags the "URL strings" in this package (the relay address).
That is informational: the relay address is the product.

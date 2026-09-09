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
and wipes the old one. After a restart, re-run connect with the new line.

The user sends that line to their AI. It downloads this package, which asks
the plugin for its two connection files and stores them under `./.golem/`:

```sh
npx golem-bridge connect <channelId>
python3 ./.golem/golem.py ping
```

`ping` should return `"ok": true` plus the open place name. Then the agent
reads `./.golem/golem.md` for the full tool reference.

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

- The CLI (`cli.js`, about 200 lines) is the only code that runs on the
agent side. Read it here, or fetch without writing anything:
`npx golem-bridge connect <channelId> --print`.
- `connect` only accepts hex channel IDs, talks HTTPS to the relay only
(never follows redirects), times out stalled requests, caps response
sizes, validates the payload shape before writing, and prints SHA-256
hashes of both files. It writes nothing unless every check passes, and
tells you to review both files before running anything.
- There are no baked-in Firebase credentials or signing keys: the channel
ID itself is the capability, and transport runs over HTTPS. Public client
code cannot hold a secret, so any "signed responses" scheme here would be
theater rather than security.
- Socket.dev flags the "URL strings" in this package (the relay address).
That is informational: the relay address is the product. The setup payload
is validated as described above before anything is written.
npm publish
```

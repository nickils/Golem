# Golem

Golem connects an AI coding agent to a live Roblox Studio session. The Studio
plugin runs commands (build, scripts, properties, marketplace) and reports
back through a private Firebase channel.

## Files

- `Golem.rbxmx` - the Studio plugin
- `cli.js` - source of the `golem-bridge` npm package
- `package.json` - npm manifest

## Studio setup

1. Copy `Golem.rbxmx` into the Studio Plugins folder and restart Studio.
2. Open the widget (PLUGINS tab, Golem). It shows one line:

```
Run: npx golem-bridge connect <channelId> -- then tell me it's connected.
```

3. Send that line to your AI. It fetches its helper and instructions from
the plugin and stores them under `./.golem/`.

## Agent setup

```sh
npx golem-bridge connect <channelId>
python3 ./.golem/golem.py ping
```

`ping` should return `"ok": true` plus the open place name. Then read
`./.golem/golem.md` for the full tool reference.

## Notes

- Relay: `https://roblox-golem-default-rtdb.firebaseio.com/`. The channel id
is the secret. It is generated once and stored in the Studio settings.
- The plugin serves `golem.py` and `golem.md` on demand. They are never
stored on the relay.
- Version is set in two places, keep them in sync: `package.json` and
`local VERSION` in the plugin source.

## Release

```sh
npm publish
```

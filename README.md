# Golem

`golem-bridge` connects an AI coding agent to a live Roblox Studio session
running the Golem plugin.

This repo holds the npm package (the AI side). The Studio plugin itself is
distributed through the Roblox Creator Store, not from here.

## How it connects

The plugin shows one line in Studio (popup on first run, also in Settings):

```
Connect to my Roblox Studio, Run: npx golem-bridge connect <channelId>
```

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

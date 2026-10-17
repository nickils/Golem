# Golem Studio panel

An optional dock panel for Roblox Studio. It is a **control room, not a relay**:
your AI talks straight to the MCP server built into Studio, and every tool call
goes there. The panel never sees those calls.

## What it is for

- **Connect** — the three setup steps and the exact `npx golem-bridge connect`
  command, with a copy button.
- **Console** — run Luau in the Edit datamodel, with `print`/`warn` captured,
  errors shown inline, and an undo waypoint per run.
- **Insert** — put an asset in the place by id: models and packages through
  InsertService, images as a decal, audio as a Sound, meshes as a SpecialMesh,
  animations as an Animation. Parent follows your selection.
- **Skills** — the seven Roblox-authored skills, each with a ready prompt.

Searching the marketplace is intentionally not here: the Creator Store search
lives in Studio's MCP server, so `npx golem-bridge search` (and the AI) covers
models, images, audio, video, meshes, animations, plugins, and packages.

## Visual rework

The panel was rebuilt around a fixed 54px header, a 36px tab bar, and a 30px
footer, so content can never slide under the chrome. Beyond the layout:

- one `UIListLayout` per container (the old header and step rows had two,
  which is undefined layout behaviour in Studio);
- no custom fields on Instances — tab indicators live in a Lua table, which
  avoids the "indicator is not a valid member" runtime error;
- cards size to their wrapped text instead of using fixed heights, so labels
  no longer clip at narrow dock widths;
- one scroll area per tab with a 4px custom scrollbar;
- buttons got consistent hover/press colours and a disabled-free 30px target;
- the code block's copy button sits inside its padding instead of hanging off
  the edge;
- the tab bar starts below the header instead of overlapping it;
- the onboarding card reuses the card's stroke instead of stacking a second
  one, and is dismissed once (`Golem/Onboarded`).

## Install

1. Download `Golem.rbxmx` from this folder (or build it).
2. In Studio: **Plugins → Plugins Folder**, drop the file in, restart Studio.
3. The panel opens on the right. The toolbar button and the `?` in the header
   bring it back.

The CLI does not need this plugin. Install it only if you want the panel.

## Build

```sh
cd plugin
python3 build.py
```

`build.py` wraps the single Script in a minimal `.rbxmx` and re-parses it,
asserting that `Source` round-trips byte-for-byte. Control characters and
`]]>` are rejected.

## Test

There is no Roblox renderer in CI, so the panel is exercised with a strict
fake object model under fengari:

```sh
npm install
npm run test:plugin
```

`test/plugin-stub.lua` builds the panel, clicks every tab, runs Luau, inserts
models and images, copies a skill prompt, toggles the toolbar button, and
asserts there is never more than one layout per container. Unknown Instance
properties raise, matching Studio. What it cannot check is pixels: colours,
spacing, and resize behaviour still need one pass in Studio.

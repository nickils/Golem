# Golem

`golem-bridge` puts an AI coding agent inside a live Roblox Studio session:
the classic Roblox skills, the Creator Store marketplace, and a Luau console.

It talks to the MCP server that **ships inside Roblox Studio**. There is no
plugin to install, no relay, no channel id, no Firebase project, and no state
kept between commands. The CLI launches Studio's own MCP binary, calls one
tool, prints the result, and exits.

## Requirements

- Roblox Studio on **macOS or Windows**, open with a place loaded.
- Studio's MCP server turned on:
  **Assistant → ⋯ → Manage MCP Servers → Enable Studio as MCP server**.
- Node.js 18+ to run `npx golem-bridge`.

That is the whole setup. If Studio is not running or the toggle is off, the
CLI says so; nothing needs reinstalling.

## Connect

```sh
npx golem-bridge connect
```

This performs the MCP handshake, lists the open Studio windows, and then
**prints the tool manual** so the agent has every command and rule in front
of it. `connect --brief` skips the manual; `status` prints one line.

## Use

```sh
# Luau, exactly like the Studio command bar
npx golem-bridge run 'print(game.Name, #game:GetDescendants())'
npx golem-bridge run --client 'print(game.Players.LocalPlayer.Name)'
npx golem-bridge run --file fix.luau

# Explore and edit
npx golem-bridge tree Workspace --depth 2
npx golem-bridge inspect Workspace.Baseplate
npx golem-bridge read ServerScriptService/Main
npx golem-bridge grep "DataStoreService"

# Playtest
npx golem-bridge play
npx golem-bridge logs
npx golem-bridge stop
npx golem-bridge screenshot --out viewport.png

# Marketplace
npx golem-bridge search "low poly pine tree"
npx golem-bridge insert 123456789 --parent Workspace.Props

# Roblox-authored skills
npx golem-bridge skills
npx golem-bridge skill rbx-perf-profiling

# Anything the tool table offers
npx golem-bridge tools
npx golem-bridge call multi_edit '{"path":"ReplicatedStorage/Foo","source":"return 1"}'
```

Every command accepts `--json` for the raw MCP result, `--studio <id|name>`
when several Studio windows are open, and `--timeout <seconds>`.

## What the agent gets

`connect` prints [`golem-tools.md`](golem-tools.md): the command map, the
classic skills, the marketplace workflow, how Luau execution differs between
`Edit`, `Client`, and `Server`, and the safety rules (changes to the place are
not always undoable; ask before destructive edits or paid asset inserts).

The tool list itself is read from the running Studio with `tools`, so a new
Studio version that renames a tool or argument keeps working: Golem resolves
tools and argument names against the live schema instead of hardcoding them.
`call` is the escape hatch for anything without a shortcut.

## Classic skills

Studio's `skill` tool serves the Roblox-authored set — `rbx-create-skill`,
`rbx-debug`, `rbx-device-simulator-lua`, `rbx-docs-search`,
`rbx-perf-profiling`, `rbx-scene-analysis`, `rbx-unit-test` — plus anything
newer your Studio version adds. `skills` lists what is actually installed and
`skill <name>` loads one. None of them runs arbitrary Luau, which is what
`run` is for.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Studio did not attach` | Open a place; enable the MCP toggle; wait a second after launch. |
| `Studio MCP was not found` | Install/update Studio, or set `GOLEM_STUDIO_MCP` to the binary. |
| `several Studio windows` | Pass `--studio` with an id or name from `studios`. |
| `no response to 'tools/list'` | The MCP toggle is off or Studio is busy; re-enable it. |
| Studio shows no connected clients | Expected: the connection lasts one command. |

Binary locations used automatically:

- macOS: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
- Windows: `%LOCALAPPDATA%\Roblox\mcp.bat`, then
  `%LOCALAPPDATA%\Roblox Studio\StudioMCP.exe`

Set `GOLEM_STUDIO_MCP` to override the path.

## Development

```sh
npm test
```

The suite is dependency-free and runs against `test/fake-studio-mcp.js`, a
stand-in that speaks Studio's JSON-RPC dialect, including pagination, late
attach, multi-window routing, alternate schema names, timeouts, and crashes.
No Studio install is required.

## Safety

Golem can change the user's place. Edits are not always undoable, and
publishing or paid asset inserts have real consequences. The manual tells the
agent to describe large or destructive changes before running them; keep that
rule if you fork this.

## License

MIT.

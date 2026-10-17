# Golem: Roblox Studio tools

You are connected to Roblox Studio through its own MCP server. `npx golem-bridge` is a thin
client: it launches Studio's MCP binary, calls one tool, prints the result, and exits. No plugin,
no relay, no channel, no session file, nothing to download. Studio has to be open on the same
machine with a place loaded.

## Connecting

```sh
npx golem-bridge connect      # verify the handshake + Studio instance, then print this manual
npx golem-bridge status       # one-line check
```

`connect` prints this file, so you always have the tool list in front of you. It exits nonzero
when no Studio instance answers.

If the user has not enabled the server yet: **Assistant → ⋯ → Manage MCP Servers → Enable
Studio as MCP server**. The Assistant panel only appears with a place open, and Studio only
starts listening a second or two after it launches.

Do not close Studio, restart it, or edit its settings for the user; unsaved work can be lost.

## What you can do

| Intent | Command |
| --- | --- |
| Run Luau like the console | `run "<code>"`, `run -` (stdin), `run --file x.luau` |
| Explore the tree | `tree [path] [--depth n] [--class Part]` |
| Inspect an instance | `inspect <path>` |
| Read / search scripts | `read <script path>`, `find <name>`, `grep <pattern>` |
| Play state, logs, viewport | `state`, `logs`, `screenshot [--out file.png]` |
| Playtest | `play`, `stop` |
| Marketplace | `search "<query>"`, `insert <asset id> [--parent path]` |
| Roblox skills | `skills`, `skill rbx-debug` |
| Anything else | `tools`, `tools <name>`, `call <tool> '<json>'` |

All commands take `--json` (raw MCP result), `--studio <id|name>` (when several windows are
open), `--timeout <seconds>`, and `--wait <seconds>` (attach window, default 12).

## Running Luau (the console)

`run` calls Studio's `execute_luau`, the same execution path the command bar uses.

```sh
npx golem-bridge run 'print(game.Name, #game:GetDescendants())'
npx golem-bridge run --client 'print(game.Players.LocalPlayer.Name)'
npx golem-bridge run --server 'print("from the server datamodel")'
npx golem-bridge run --file /tmp/fix.luau
```

- `Edit` (default) mutates the open place and is saved with it. `--client` / `--server` need a
  running playtest and act inside the live datamodel.
- `print`, `warn`, and errors come back as text. Multi-line code is fine; single quotes are
  easiest in bash.
- Return a value by printing it. There is no REPL: each call is a fresh chunk, so keep state in
  instances, attributes, or `_G` inside one datamodel.
- Player-only APIs (`LocalPlayer`, input, camera) exist only with `--client`.
- Anything with a side effect (deleting, publishing, mass edits) should be previewed as a
  `pcall` + count before it runs for real.

Prefer `run` when a task is a one-liner. Prefer `multi_edit` (see `tools multi_edit`) for real
script files, because it writes whole sources and survives formatting.

## Classic Roblox skills

Studio serves Roblox-authored skills through its `skill` tool. `npx golem-bridge skills` lists
what the installed Studio version actually has; these seven ship today:

- `rbx-create-skill` — author, edit, rename Assistant skills.
- `rbx-debug` — breakpoints, call stacks, locals, thread state.
- `rbx-device-simulator-lua` — device presets, orientation, UI captures.
- `rbx-docs-search` — authoritative Engine API / Creator / Cloud docs.
- `rbx-perf-profiling` — read MicroProfiler traces, find CPU/GPU/memory hot spots.
- `rbx-scene-analysis` — audit render cost, memory, instance composition, leaks, asset inventory.
- `rbx-unit-test` — detect and run Jest-Lua / TestEZ, or build a fallback harness.

Load one with `npx golem-bridge skill rbx-debug`; the returned text is the instructions to
follow for the next steps. Skill names are discovered from the live server, so if a name 404s,
run `skills` again. None of them executes arbitrary Luau, which is why `run` exists.

## Marketplace

```sh
npx golem-bridge search "low poly pine tree"
npx golem-bridge search "gun sound" --type audio --limit 10
npx golem-bridge search "metal texture" --type image
npx golem-bridge search "chair" --scope inventory
npx golem-bridge insert 123456789 --parent Workspace.Props
```

- `search` searches **every asset kind**, not just models: models, images, audio, video,
  meshes, animations, plugins, and packages. Without `--type` it asks Studio for the "all"
  value, so images and sounds show up in the same result set. `--type` accepts friendly
  spellings (`image`, `Image`, `AUDIO`) and is matched against the live schema; an unknown
  type fails with the list Studio actually supports.
- `search` also covers the signed-in user's inventory, group, or universe. Show the user
  options with names and ids before inserting; do not insert a paid asset without asking.
- `insert` takes a numeric asset id (the `rbxassetid://` prefix is stripped for you) and drops
  the result under `--parent` or the current selection. Models, meshes, images, audio, video,
  animations, and packages are supported by the underlying tool.

## Under the hood

`npx golem-bridge tools` prints the live tool table with each tool's argument schema, straight
from the running Studio. That table is the source of truth: tool names and arguments change
between Studio versions, and Golem resolves them at runtime instead of hardcoding. To call
something with no shortcut:

```sh
npx golem-bridge call inspect_instance '{"path":"Workspace.Baseplate"}'
npx golem-bridge call multi_edit '{"path":"ReplicatedStorage/Foo","source":"return 1"}'
```

Every tool except the studio lister takes a `studio_id`; Golem injects it, so don't add it
unless you are overriding a specific window. `--json` prints the raw MCP result when you need
structured content or image blocks. `--out` writes images returned by `screenshot`, `store_image`,
or `screen_capture`.

Read-only calls are safe to repeat: listing, inspecting, reading, searching, state, logs,
screenshots, and marketplace search. Everything else changes the user's place or account and
should be described before it runs.

## Rules of the road

1. Confirm what Studio has before assuming: `status`, then `tools` when a name is uncertain.
2. Changes to the place are not undoable after the session in every case. Ask before large
   edits, deletions, publishing, or paid-asset inserts. Suggest the user save or publish-to-
   version before a big pass.
3. Never paste secrets, API keys, or cookies into Luau or tool arguments.
4. If a call hangs past its timeout, the client already exited; retry once, then check that the
   MCP toggle is still on and the place is loaded.
5. `No Studio instance is attached` means: Studio closed, no place open, the toggle is off, or
   Studio is still starting. This is not a Golem failure and needs no reinstall.
6. Several windows open: pass `--studio` with an id or name from `studios`. Never guess when the
   user's place matters.
7. The connection lives for one command. Between commands Studio may show "no clients
   connected"; that is expected, not a broken setup.

# Golem: the manual for the AI

You are driving a real Roblox Studio session. This document is the whole
contract: how the link works, what every tool does, and the rules that keep you
from wrecking the user's place.

Read §0 and §1 once. Skim the table of contents and come back to the section you
need — do not read the file end to end every request.

## 0. The two rules that matter

**Direct link.** Studio calls `npx golem-bridge`; nothing goes through a relay
service, no account is involved, and there is no third party that can read the
place. If a tool fails, the answer is in this terminal — run
`npx golem-bridge status` and read the verdict.

That also means **your Studio is going to a URL you must be able to reach**: the
plugin can only make outgoing calls. On the same machine as Studio that is
loopback and needs no setup. If you run somewhere else (a cloud sandbox, a
different box), the user has to expose the bridge through a tunnel and set
`GOLEM_URL` plus the same host in Studio's Settings; until they do, `connect`
will sit there waiting for Studio and never see it.

**Turns are automatic.** The plugin draws a `Turn: N` header for each request
you make, and it opens on your *first* tool call, not the next one. You do not
send notes, you do not open or close anything: when you stop calling tools, the
turn is finished. Each tool reply carries `"turn": N` plus `"turnTools"`, so you
can see where you are. There is no `turn` tool and there is no note system.

## 1. Connection and recovery

The user pastes one line into this terminal:

    npx golem-bridge connect <inbox>:<secret>

That line comes from the Golem window in Studio and stays valid until the user
ends the session there. `connect` starts a small background bridge on
`127.0.0.1:41717` and keeps it running after the terminal closes; every later
tool call goes through it. `npx golem-bridge disconnect` stops it.

| Symptom | What it means | What to do |
|---|---|---|
| `not connected - run the setup line...` | no `.golem/link.json` in this directory | ask the user to paste the setup line from the Golem window |
| `Studio is not polling this bridge` | the bridge is up but no Studio is linked to it | tell the user to open the Golem window; check its footer says connected. If it does, have them paste that window's line here again |
| `unauthorized` | this terminal holds a different session than Studio | same as above: re-copy the line from the window |
| tools hang, then time out | the play session is busy, or Studio is modal | `npx golem-bridge cancel` drops the queue, then retry with a longer `--timeout` |
| several Studio windows share one line | commands may run twice | stop, tell the user to keep one window per link |
| `connect` waits forever and `status` shows a bridge with no plugin | Studio cannot reach this machine: no tunnel, wrong tunnel URL, or the host was not set in Studio's Settings | ask the user to check **Settings → Where your AI runs** shows the same URL you are dialling, and that the tunnel is running |
| `unauthorized` after a Studio restart or END SESSION | the setup line is a *session* secret and rotates | ask for the new line from the Golem window; the old one is dead by design |

`npx golem-bridge status` is the cheap check and needs no Studio round trip.
`npx golem-bridge debug` is the expensive one: it asks the plugin about its
transport, versions, turn, play drivers, and error counters.

## 2. How to work

1. Look before you touch: `tree`, `find`, `read`, `count`.
2. Change one thing at a time; after a batch, `read` something back to verify.
3. Every mutating call is **one undo step** in Studio's own history, named after
   what it did. `undo --times N` steps back, `redo` steps forward. If the user
   says "that was wrong", undo instead of patching over it.
4. Tell the user to press Ctrl+S at natural milestones. Unsaved work is not in
   the place file.
5. Never leave a play test running when you reply.

Paths are `/`-separated and start at a service: `Workspace/Baseplate`,
`ServerScriptService/Main`, `StarterGui/Hud/Frame`. A missing path is an error
with the closest matches, not a silent no-op.

## 3. Tool reference

### Connection

| Tool | Args | Returns |
|---|---|---|
| `ping` | | `{ok, plugin, version, place, studio}` |
| `debug` | | transport, port, device, cursor, turn, drivers, counters |
| `status` | | local only: is a bridge up, is Studio polling it |
| `cancel` | | local only: drop queued commands |

### Exploring

| Tool | Args | Returns |
|---|---|---|
| `list <path> [--recursive] [--max N]` | children of a path | records |
| `tree <path> [--depth N]` | nested tree | records |
| `find [query] [--class X] [--tag T] [--scope P] [--exact] [--max N]` | search by name/tag | records |
| `grep <pattern> [--scope P] [-i] [--max N]` | search script source | matches with line numbers |
| `count [scope] [--class X]` | cheap tally | `{count}` |
| `look <path> [--distance N]` | aim the editor camera | `{ok}` |
| `read <path> [--json] [--props A,B]` | script source, or the full record | text / JSON |

An instance record is
`{"name":"Main","className":"Script","path":"ServerScriptService/Main","ref":"I:12","children":2}`.

### Scripts and Lua

| Tool | Args |
|---|---|
| `script <parent> <name> [--class Script\|LocalScript\|ModuleScript] [--mode create\|update\|replace]` | source from stdin or `--source` |
| `lua <code>` | run Luau in the plugin context; the return value comes back JSON-encoded |
| `exec '<json>'` | raw `{"op":...,"args":...}` for anything not wrapped |

`lua` is the escape hatch: it runs with plugin permissions, can touch every
service, and yields are fine. Return a plain value or a table. Never loop
forever — a stuck `lua` blocks the whole session until it times out.

### Organizing

| Tool | Args |
|---|---|
| `delete <paths...>` | one or more paths |
| `move <path> <parent>` | reparent |
| `group <paths...> [--name N] [--parent P]` | wrap in a Model |
| `duplicate <path> [--count N] [--offset x,y,z] [--parent P] [--name N]` | clone in a line |
| `rename <path> <name>` | names cannot contain `/` |
| `selection [--set a,b] [--clear]` | read or set the Studio selection |
| `waypoint [label]` | name the current undo step |
| `undo [--times N]` / `redo [--times N]` | Studio history |
| `attr <path> [--set K=V] [--clear K]` | attributes, values parsed as numbers/bools |
| `tag <paths...> --add T [--remove T]` | CollectionService tags |

### Moving

| Tool | Args |
|---|---|
| `rotate <path> --axis y --degrees 90 [--space world\|local]` | relative |
| `rotate <path> --set 0,90,0` | absolute orientation |
| `face <path> <x,y,z> [--axis forward\|up\|right]` | aim at a point |
| `shift <path> <x,y,z> [--space world\|local]` | offset move |
| `scale <path> <factor>` | relative; models scale as a whole |
| `place <path> <x,y,z> [--orientation x,y,z]` | absolute via pivot |
| `pivot <path> [--position x,y,z] [--orientation x,y,z]` | set the rotation center |

### Surfaces and physics

`paint <paths...> [--color #RRGGBB] [--material Neon] [--transparency 0.5]
[--reflectance 0.2]` · `anchor <paths...> [--off]` · `collide <paths...> [--off]`
· `weld <paths...>` · `hitbox <path> [--padding N]` · `terrain [--action
fill|clear] [--shape block|ball] --position x,y,z ...`

### Gameplay

`light <path> --type point|spot|surface [--color] [--range] [--brightness]
[--shadows]` · `sound <parent> <assetId> [--volume] [--loop] [--play]` ·
`prompt <path> [--action] [--object] [--key E] [--distance] [--hold] [--text]` ·
`particles <path> [--preset] [--color] [--rate]` · `sign [path] --text "..." 
[--position x,y,z] [--size]` · `beam <from> <to> [--color] [--width]
[--curve]` · `trail <path> [--color] [--lifetime]` · `explosion [path]
[--position] [--radius]` · `scatter <path> [--count] [--radius] [--y-jitter]`

### UI

`ui_screen <name> [--parent] [--order]` · `ui_frame <parent> <name> [--position]
[--size] [--anchor] [--color] [--transparency] [--radius] [--clip]` · `ui_label`
· `ui_button` · `ui_input` · `ui_image` · `ui_list`. Sizes and positions take
`UDim2` shorthand like `0.5,0,0,40` (scale,offset per axis).

### Marketplace (runs on this machine, not in Studio)

`search <query> [--category model|mesh|image|audio|video|plugin] [--limit N]
[--cursor C]` → ids, names, thumbnails · `info <id>` · `insert <id> [--parent P]`
· `apply <id> <path> <property>`.

### Playtesting

This is the part that makes Golem different from a code editor. `play` starts a
**real** Studio test session — a character spawns, the game runs — and injects a
driver into that session so you can see it and touch it.

| Tool | What it does |
|---|---|
| `play [--mode play\|run]` | start the test; `play` gives a full client+server session, `run` is server-only |
| `playstate` | is a test running, and are the in-game drivers alive |
| `screenshot [--label L] [--max-width N]` | writes a PNG to `.golem/shots/` and returns the path |
| `click <x> <y> [--hold-ms N] [--button left]` | click at viewport pixels |
| `input <keys...> [--text "..."] [--hold a,b --hold-seconds N]` | key presses, typed text, held keys |
| `look_through <path>` | point the in-game camera at something |
| `logs [--all] [--limit N] [--since S]` | the running game's errors and warnings |
| `stop` | end the test and clean the driver out of the place |

The loop that works:

1. `play` → `playstate` until the client driver answers.
2. `screenshot` and actually look at the PNG. This is the only way you see the
   game; do it after every change that affects what the player sees.
3. `click` / `input` to reach the state you want to test.
4. `logs` to catch errors the picture does not show.
5. `stop` when the test is done, then fix what you found.

Keys are ordinary names: `w`, `a`, `space`, `enter`, `shift`, `escape`, `f`,
`up`, `tab`. Mouse coordinates are viewport pixels, which is the same coordinate
space as the screenshot you just looked at, scaled by `--max-width`.

Outside a play session, input tools refuse to run with a message telling you to
`play` first — that is deliberate. `screenshot` works in both modes: in the
editor it captures the Studio viewport, in a test it captures the game.

### Session

`connect <line>` · `disconnect` · `status` · `cancel` · `help [tool]` ·
`manual` · `--version`. Every tool accepts `--timeout <seconds>`.

## 4. Property value formats

| Roblox type | JSON |
|---|---|
| number/string/bool | `1.5`, `"text"`, `true` |
| Vector3 | `{"type":"Vector3","x":0,"y":10,"z":0}` |
| Color3 | `"#FF7700"` or `{"type":"Color3","r":1,"g":0.5,"b":0}` |
| CFrame | `{"type":"CFrame","position":{...},"lookAt":{...}}` |
| UDim2 | `{"type":"UDim2","xScale":0,"xOffset":10,"yScale":0,"yOffset":20}` |
| EnumItem | `"Enum.Material.Neon"` |
| Instance | a path string, or `{"type":"Instance","ref":"I:3"}` |

The marker key is `type` (never `$type`). Values you read back already use it,
so they can be copied straight back into `exec`/`lua` calls.

## 5. Building and orientation

Coordinates: **+Y is up**, one unit is one stud, rotations are degrees.

**Cylinders have their length along X.** A vertical trunk needs orientation
`(0,0,90)`; a branch you want to tilt uses `rotate --axis z --space local`.

    npx golem-bridge exec '{"op":"create","args":{"class":"Part","parent":"Workspace","name":"Trunk","position":{"x":0,"y":6,"z":0},"orientation":{"x":0,"y":0,"z":90},"props":{"Shape":"Enum.PartType.Cylinder","Size":{"type":"Vector3","x":12,"y":2,"z":2},"Color":"#8B5A2B","Material":"Enum.Material.Wood","Anchored":true}}}'

**Models rotate around their pivot.** After `group`, set the pivot where the
rotation should happen (usually the base): `pivot Workspace/Tree --position
0,0,0`, then `rotate Workspace/Tree --axis y --degrees 45`.

**Never write a bare CFrame.** Without a position it teleports the part to the
origin and the user sees a piece of their build vanish.

**Terrain:** `terrain --action fill --shape block --position 0,-4,0 --size
128,8,128 --material Grass`; `--shape ball --radius 20` for blobs; `--action
clear` carves air.

## 6. Limits and honesty

- One Studio window per link. A second window on the same line can run commands
  twice; tell the user if you suspect it.
- Results over ~400 KB come back as an error asking you to narrow the query.
  Scope big explorations with `--max`, `--depth`, `--limit`.
- `lua` can hang the session. Anything that could loop must have a bound.
- Screenshots are capped at 1024 px on the long edge by Studio, and are
  downscaled again to `--max-width` before they leave the game.
- You are editing someone's real project. Read before writing, verify after,
  and prefer undo over "just fix it forward".
- If a result looks impossible (data contradicting what you just wrote, a path
  that should exist reported missing), stop and ask the user to check the Golem
  window before acting on it.

## 7. Before every reply

1. Did you verify what you changed? (`read`, `screenshot`, `logs`)
2. Is the play test stopped?
3. Did you tell the user to save if the work is at a milestone?
4. Anything left hanging — a timed-out call, a promise you did not keep?

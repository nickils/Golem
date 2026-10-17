---
name: golem-scaffold
description: Create or repair a Roblox project skeleton with canonical folders, bootstrap scripts, module contracts, remotes, config, and a save stub. Use after a game brief, when starting a system, or when a place has no clear structure.
enabled: true
---

# Scaffold the project

Create the smallest structure that can run, be extended, and be tested. The
result is not a framework: it is a clear place to put the next ten systems.

## Rules

- **Inspect first.** Use `get_studio_state`, `search_game_tree`, and
  `script_search` before creating anything. List what already exists.
- **Never delete, rename, or move user content without asking.** If an existing
  script conflicts, propose the move and wait.
- **Change one layer at a time.** Folders, then config, then remotes, then
  server boot, then client boot, then stubs.
- **Server owns state.** Currency, inventory, progress, health, and rewards are
  decided on the server. The client sends intent and renders results.
- **No legacy APIs.** Use `task.wait`, `task.spawn`, and `task.delay`; never
  `wait`, `spawn`, or `delay`. Use `workspace`, not `game.Workspace`.
- **One responsibility per module.** If a module needs "and" to describe it,
  split it.
- **No magic numbers in systems.** Tunables live in `Shared/Config`.
- **Remotes are a public API.** Name them, validate arguments, rate-limit them,
  and create them in one place.
- **Do not implement production persistence unasked.** Provide the interface
  and an in-memory stub; real DataStore code needs the user's approval and a
  test place.

## Canonical layout

Create only the branches the project needs, but keep these names stable:

```text
ReplicatedStorage
  Shared
    Config          (ModuleScript)
    Remotes         (ModuleScript)
    Util            (Folder)
  Assets            (Folder)

ServerScriptService
  Bootstrap         (Script)
  Systems           (Folder)
    DataService     (ModuleScript)
    <Domain>Service (ModuleScript)

StarterPlayer
  StarterPlayerScripts
    ClientBootstrap (LocalScript)
    Controllers     (Folder)

ServerStorage
  Templates         (Folder)

Workspace
  Map               (Folder)
```

If the user uses Rojo, mirror this with `init.server.lua`, `init.client.lua`,
and `.lua` modules; the runtime tree stays the same.

## 1. Inventory and plan

1. Read the tree at depth 3 and search scripts for `Bootstrap`, `Config`,
   `Remotes`, and `Data`.
2. Write a short diff: **create**, **reuse**, **move (ask)**, **delete
   (never)**.
3. Stop and confirm only if a move or delete is required.

## 2. Create the shared layer

Config holds values, not logic:

```lua
--!strict
-- ReplicatedStorage/Shared/Config (ModuleScript)
local Config = {}

Config.saveVersion = 1
Config.startingCoins = 0
Config.interactRange = 8
Config.sessionSeconds = 900

return Config
```

Remotes names the API and exposes lookups; the server creates the instances:

```lua
--!strict
-- ReplicatedStorage/Shared/Remotes (ModuleScript)
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = {}
local folder = ReplicatedStorage:WaitForChild("Remotes")

local EVENTS = {
	Interact = "RemoteEvent",
	BuyUpgrade = "RemoteEvent",
}

function Remotes.get(name: string): Instance
	local className = EVENTS[name]
	if not className then
		error("Remotes: unknown remote " .. name, 2)
	end
	local remote = folder:FindFirstChild(name)
	if not remote or not remote:IsA(className) then
		error("Remotes: " .. name .. " is missing on the server", 2)
	end
	return remote
end

return Remotes
```

Create the folder and instances in the server bootstrap so clients can never
invent a remote.

## 3. Add the server boot

```lua
-- ServerScriptService/Bootstrap (Script)
local Systems = script.Parent:WaitForChild("Systems")

local ORDER = { "DataService", "EconomyService", "InteractionService" }
local loaded = {}

for _, name in ipairs(ORDER) do
	loaded[name] = require(Systems:WaitForChild(name))
end
for _, name in ipairs(ORDER) do
	if loaded[name].Init then
		loaded[name]:Init()
	end
end
for _, name in ipairs(ORDER) do
	if loaded[name].Start then
		loaded[name]:Start()
	end
end

print("[Golem] bootstrap ready")
```

Every system follows the same contract:

```lua
--!strict
local EconomyService = {}

function EconomyService:Init()
	-- wire dependencies, no yields
end

function EconomyService:Start()
	-- connect events, start loops
end

return EconomyService
```

`Init` runs for all systems before any `Start`, so startup order stays
predictable. Do not yield in `Init`; use `task.spawn` for long work in `Start`.

## 4. Add the client boot

```lua
-- StarterPlayer/StarterPlayerScripts/ClientBootstrap (LocalScript)
local Controllers = script.Parent:WaitForChild("Controllers")
local order = { "HudController", "InputController" }

local loaded = {}
for _, name in ipairs(order) do
	loaded[name] = require(Controllers:WaitForChild(name))
end
for _, name in ipairs(order) do
	if loaded[name].Start then
		loaded[name]:Start()
	end
end

print("[Golem] client ready")
```

The client may read replicated state and request actions. It must not decide
rewards, currency, health, or ownership.

## 5. Add the save contract

```lua
--!strict
-- ServerScriptService/Systems/DataService (ModuleScript)
local DataService = {}

local TEMPLATE = {
	version = 1,
	coins = 0,
	inventory = {},
}

local cache: { [Player]: typeof(TEMPLATE) } = {}

function DataService:Load(player: Player)
	cache[player] = table.clone(TEMPLATE)
	return cache[player]
end

function DataService:Get(player: Player)
	return cache[player]
end

function DataService:Save(_player: Player)
	-- TODO: persist after the loop is approved. Keep this a stub until then.
end

return DataService
```

Write the schema version on every save and add a migration hook before the
first real save. Never test destructive DataStore code on a live place.

## 6. Wire one vertical slice

Do not create empty modules for every future system. Create only the systems
named in the brief's M0–M1 milestones:

1. `DataService` returns the profile.
2. `EconomyService` reads and changes coins on the server.
3. `InteractionService` validates range and intent, then calls economy.
4. Client controller renders coins and sends intent.

This is enough to prove the structure. Additional systems follow the same
contract.

## 7. Verify

Do all of these before reporting success:

- `search_game_tree` shows the expected folders and scripts, with no duplicates.
- `script_search` finds exactly one bootstrap per side.
- Play mode starts, and `get_console_output` contains `[Golem] bootstrap ready`
  and `[Golem] client ready`.
- There are no errors or warnings in the console.
- The client can trigger the one wired action, and the server state changes.
- Stop play, then start again: the structure still boots.

If a check fails, fix the smallest cause and rerun. Never claim "it should work"
without a clean boot log.

## 8. Report

End with:

```markdown
## Scaffold

Created: <paths>
Reused: <paths>
Moved (approved): <paths or none>

Contract: Init -> Start for systems; Start for controllers
Remotes: <names and argument types>
Save: version <n>, stub only / implemented

Verification: play boot clean, console <quote the line>, one action round-trip

Next action: build M1 from the brief, then run `golem-playtest-qa`.
```

## Anti-patterns

- One giant `Main` script that creates everything.
- Requiring modules by global name or loose `WaitForChild` everywhere.
- Client-side currency changes or "trust the client" remotes.
- Creating a module for every idea before the loop exists.
- Adding a framework, dependency, or package without approval.
- Editing while play mode is running and calling it verified.

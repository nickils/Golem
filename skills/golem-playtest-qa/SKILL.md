---
name: golem-playtest-qa
description: Run a structured Roblox playtest and QA pass with scripted scenarios, server and client logs, screenshots, and a prioritized regression report. Use before shipping a change, after a scaffold, or when the user asks to test, verify, or find bugs.
enabled: true
---

# Playtest and QA

Prove the change works, then prove it does not break what already worked. The
output is a pass/fail matrix, evidence, and a short list of defects — not a
sentence that says "looks good".

## Rules

- **Save first.** Ask the user to save or publish a version before testing.
  Agent edits are not always undoable, and a playtest should never be the first
  place a change exists.
- **Do not edit during play.** Finish edits, then start the test. If a fix is
  needed, stop play, fix, and rerun the failed rows.
- **Never run destructive tests on live data.** Purchases, DataStore writes,
  profile resets, and currency grants need a test place and explicit approval.
- **Read-only assertions.** Use `execute_luau` to inspect state, not to grant
  resources or skip gameplay.
- **One variable per run.** Change one thing, rerun the affected scenario, do
  not rerun the whole matrix after every edit.
- **Record evidence.** Every failure needs repro steps, the console line, and a
  screenshot when visual.
- **Do not stop or restart Studio.** Stop play mode only.

## 1. Preconditions

1. `get_studio_state` — confirm Edit, not a stuck play session.
2. Confirm the place is saved; if unsaved changes exist, ask the user to save.
3. Confirm the test scope: which milestone or change, and what must not break.
4. If the change touches saving, ask for a test place or a disposable profile.
5. Note the device targets (phone, tablet, desktop) and whether multiplayer is
   in scope.

## 2. Build the matrix

Start from the brief's acceptance checks. If there are none, use this default
set and mark rows that do not apply:

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | Boot | Play starts, no errors or warnings |
| 2 | Spawn | Character appears, controls respond |
| 3 | Core loop once | Action → feedback → reward → next goal |
| 4 | Core loop ×3 | Reward accumulates, no duplicate or lost grants |
| 5 | Fail and reset | Fail state fires, reset returns to playable |
| 6 | Persistence | Rejoin restores progress and schema version |
| 7 | UI sizes | HUD/menu usable on phone and desktop |
| 8 | Invalid input | Bad or spammed remote rejected, no server error |
| 9 | Multiplayer (if in scope) | Two players see consistent state |
| 10 | Performance sanity | Memory stable over 3 loops, no error spam |

Expand a row into concrete steps before running it. "Test the shop" is not a
scenario; "buy the first upgrade with 10 coins, confirm the balance and the
tool change" is.

## 3. Run it

For each scenario:

1. Start play: `start_stop_play` with `is_start: true`.
2. Wait for `get_studio_state` to report a running session.
3. Drive the scenario with `character_navigation`, `user_keyboard_input`, and
   `user_mouse_input`. Prefer real input over teleporting the character.
4. Assert with `execute_luau`:
   - `datamodel_type: "Server"` for authority and saved values.
   - `datamodel_type: "Client"` for HUD text, camera, and local feedback.
5. Read `get_console_output`; treat any new error as a blocker, and any new
   warning as at least a minor defect.
6. Capture `screen_capture` for visual rows and for every failure.
7. Reset between scenarios: stop play and start again, or use the game's own
   reset. Rejoining is part of the persistence row.

Useful assertions:

```lua
-- Server: the authoritative value, never the UI
local player = game:GetService("Players"):GetPlayers()[1]
print("coins", player:GetAttribute("Coins"))

-- Server: the save schema is present and versioned
local data = require(game.ServerScriptService.Systems.DataService)
local profile = data:Get(player)
print("saveVersion", profile and profile.version)
```

Stop and inspect, rather than rerunning, when the console shows a stack trace
that points at a module loaded during startup.

## 4. Judge

Assign one severity per failure:

- **Blocker** — cannot boot, cannot complete the loop, data loss, or a server
  error. Stop the matrix and fix first.
- **Major** — loop completes but a reward, a fail state, or a save is wrong.
- **Minor** — visual, text, audio, or a recoverable edge case.
- **Note** — polish or a question for the user, not a defect.

Do not downgrade a console error because the feature "still works". Do not
mark a row passed if it was not run; write **not tested** and say why.

## 5. Performance sanity

Only after the functional rows pass:

1. Run the loop three times.
2. Sample client memory and frame time once per loop:
   ```lua
   -- Client datamodel
   local stats = game:GetService("Stats")
   print("memoryMb", stats:GetTotalMemoryUsageMb())
   ```
3. Compare the first and last sample. A steady climb across identical loops is
   a leak signal, not noise.
4. If frame time regresses, stop here and hand off to `rbx-perf-profiling` for
   a MicroProfiler trace. Do not guess at the cause from one sample.

## 6. Report

```markdown
## QA — <place> — <date>

Scope: <milestone or change>
Build: <saved version or "unsaved">
Devices: <phone/tablet/desktop>
Players: <1 or 2>

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Boot | pass | console |
| 3 | Core loop once | fail | shot 3, console line |

### Defects
1. **Blocker — <title>**
   - Expected: ...
   - Actual: ...
   - Repro: 1. ... 2. ... 3. ...
   - Evidence: <screenshot id/path, console quote>
   - Suspect: <script path>
   - Suggested fix: <one line, not an implementation>

### Not tested
- <row> — <reason>

### Performance
- memory: <first> → <last> MB over 3 loops
- console: <error/warning counts>

**Verdict:** <blocked | pass with known issues | pass>
```

Sort defects by severity, not discovery order. Quote console lines exactly;
paraphrasing hides the stack trace.

## 7. Clean up

- Stop play mode.
- Remove test-only instances and attributes; restore any value you changed.
- Close extra clients if the run used them.
- Keep screenshots with the report; name them by scenario number.
- Tell the user what remains open and what you could not test.

## Anti-patterns

- One happy-path run declared as QA.
- Testing on unsaved edits.
- Granting currency or items to make a test pass.
- Ignoring warnings because the feature works.
- Editing scripts while play mode is running.
- Marking multiplayer or device rows passed without a second client or a
  device preset.
- Leaving play mode running and ending the turn.

---
name: golem-game-brief
description: Turn a rough Roblox game idea into a buildable vertical slice with a core loop, minimum systems, folder plan, milestones, and acceptance checks. Use when the user wants to start a game, scope a feature, or plan before writing code.
enabled: true
---

# Build a game brief

Turn an idea into a small plan that one person can finish. This skill does not
write game code: it produces a brief that `golem-scaffold` can execute and
`golem-playtest-qa` can test.

## Rules

- **Look before planning.** Read the place first so you do not propose systems
  that already exist. In Studio: `get_studio_state`, `search_game_tree` at
  depth 2–3, and `script_search` for `Bootstrap`, `Config`, `Remotes`, and
  `Data`. In a terminal: `npx golem-bridge tree --depth 3`.
- **At most three questions.** Ask only what changes the plan: multiplayer or
  single-player, session length, and the one feeling the game must deliver.
  If the user does not answer, choose a default, write it under **Assumptions**,
  and continue.
- **Cut hard.** The first version is a 10–20 minute loop, not a game. Every
  feature that is not needed to complete that loop belongs in the cut list.
- **No monetization, analytics, seasons, or procedural content** before the
  core loop is fun. Say so if the user asks for them early.
- **Use what exists.** Prefer the user's assets, systems, and style. Do not
  invent a new framework when the place already has one.
- **No code in this skill.** A file tree sketch is fine; scripts are the job of
  `golem-scaffold`.

## 1. Name the fantasy

Write one sentence: *"You are a ___ who ___ to ___."* Keep it concrete enough
that a stranger can picture the first minute of play.

Then write the loop in one line: **action → feedback → reward → next goal**.
Example: *"Collect scrap → sparkle and counter tick → buy a better tool →
reach the locked vault."*

If the loop needs more than one sentence, it is still two loops. Pick one.

## 2. Design the loop

Fill this table with 4–6 steps. Every step needs a visible or audible
response; a reward with no feedback is not a loop.

| # | Player action | Feedback | Reward | Next goal |
| --- | --- | --- | --- | --- |
| 1 | | | | |

Add:

- **Fail state:** what ends a run or costs progress.
- **Reset:** how the player starts again without rejoining.
- **Session shape:** first 30 seconds, first success, first upgrade, reason to
  return.

## 3. Set the scope budget

Default budget for a vertical slice — change it only with a reason:

- 1 map, built from existing or generated parts, no custom art pipeline.
- 3–5 interactables, 1 resource, 1 currency, 1 upgrade track.
- 1 enemy or hazard type, 1 fail state.
- 2 UI screens: HUD and one shop/upgrade panel.
- 1 save slot per player, 1 small schema.
- 15 minutes of authored content.

Everything else is **Cut for v1**, even if the user asked. Write the cut list
explicitly so it can be recovered later.

## 4. Pick the minimum systems

Mark each Must / Should / Cut:

- movement and spawn
- interaction or combat
- reward and progression
- persistence (save/rejoin)
- HUD and one menu
- audio feedback
- onboarding (first 30 seconds)
- multiplayer replication, only if the answer was multiplayer

If a Must system has no owner or no asset, cut it or replace it with the
simplest version that still completes the loop.

## 5. Sketch the structure

One paragraph, not a full scaffold:

- What runs on the server and owns state.
- What runs on the client and only presents or requests.
- Where config, remotes, and systems live.
- What the save schema holds (fields and version number).

Hand the exact folder plan to `golem-scaffold`.

## 6. Milestones with acceptance checks

Each milestone must be observable by someone who did not write the code:

1. **M0 — boots.** Play mode starts, one server log line, zero errors.
2. **M1 — loop.** A player can complete the loop once, including fail and reset.
3. **M2 — repeatable.** The loop works three times in a row with the reward
   persisting during the session.
4. **M3 — readable.** HUD shows the resource and the next goal; feedback fires
   on every action; UI works at phone and desktop sizes.
5. **M4 — durable.** Rejoining restores progress; schema version is recorded.
6. **M5 — ship.** 20-minute session with no errors or warnings, no lost data,
   and a written list of known issues.

Do not add milestones for content volume before M3.

## 7. Plan the assets

For each need, pick one path and write the query:

- Search the marketplace: `search_asset` for models, images, audio, meshes, or
  animations. In a terminal: `npx golem-bridge search "..." --type audio`.
- Generate: `generate_mesh`, `generate_material`, or
  `generate_procedural_model` when the shape is simple and original.
- Build from parts when the asset must be editable.
- Cut when the asset is decorative and the loop does not need it.

Never insert a paid asset without asking, and never promise an asset you have
not seen.

## 8. Write the brief

Use this exact shape so the next skill can consume it:

```markdown
## Brief: <name>

**Fantasy:** <one sentence>
**Core loop:** <action → feedback → reward → next goal>
**Session:** <minutes>, <single-player|multiplayer>

**Assumptions:** <anything decided without the user>

**Must-have systems:** <list>
**Cut for v1:** <list>

**Structure:** <server owns..., client..., folders..., save fields...>

**Milestones:**
- M0 ... acceptance: ...
- M1 ... acceptance: ...

**Asset plan:** <search queries, generated assets, part-built assets>

**Risks:** <top three, each with a fallback>

**Next action:** run `golem-scaffold` with this brief.
```

A brief that does not fit on one screen is too long.

## 9. Quality bar

The brief is ready when:

- someone can describe the game in one sentence without adding "and";
- every milestone has an acceptance check you could demo;
- the cut list is non-empty;
- the first 30 seconds of play are described;
- the asset plan names queries, not vibes;
- the next action is one skill invocation, not a research project.

## Anti-patterns

- A feature list with no loop.
- "Add multiplayer" as a v1 feature.
- Designing economy numbers before the reward feels good.
- Planning a custom framework, data layer, or UI library first.
- Writing scripts in the planning step and calling it a scaffold.
- Asking five questions and producing nothing.

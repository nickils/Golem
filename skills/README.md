# Golem skills

Three Roblox Assistant skills that cover the parts the built-in `rbx-*` set does
not: planning a game, scaffolding it, and running QA. They are Markdown files —
nothing installs automatically, and nothing here runs on its own.

| Skill | Loads when the user… |
| --- | --- |
| `golem-game-brief` | wants to start a game, scope a feature, or plan before code exists |
| `golem-scaffold` | has a plan and needs folders, boot scripts, modules, remotes, and a save contract |
| `golem-playtest-qa` | wants to test, verify, find bugs, or ship a change |

They chain in that order. Each ends with a handoff to the next one and refuses
to skip the step before it.

## Install

Skills are tied to your Roblox account, so install them once and they are
available in every place.

**From the Skills tab**

1. Assistant → **⋯** → **Assistant Settings** → **Skills**.
2. **Add**.
3. Name and description are single lines; copy them from the frontmatter.
4. Paste the body (everything after the second `---`) into the editor.
5. Save. It is enabled by default.

**With `rbx-create-skill`**

In Assistant, say:

> Use `rbx-create-skill` to create a skill from this Markdown, keeping the
> frontmatter:

then paste the output of:

```sh
npx golem-bridge skillpack golem-game-brief
```

Repeat for `golem-scaffold` and `golem-playtest-qa`. `rbx-create-skill`
validates the name, writes the description, and saves it to your account.

**From this repo**

```sh
npx golem-bridge skillpack                 # list
npx golem-bridge skillpack golem-scaffold  # print the full SKILL.md
```

`npx golem-bridge skills` is different: it lists the skills the running Studio
version actually exposes through MCP (the seven `rbx-*` ones plus any newer).
`skillpack` prints the files bundled with this package.

## Use

Enabled skills load automatically when a request matches their description. To
force one, type `/` in the composer and pick it from the slash menu. Multiple
skills can be attached to one message — `golem-game-brief` plus
`golem-playtest-qa` is a reasonable pair for "plan it and test the result".

## Layout

```text
skills/
  README.md
  golem-game-brief/SKILL.md
  golem-scaffold/SKILL.md
  golem-playtest-qa/SKILL.md
```

Frontmatter follows Roblox's rules:

```yaml
---
name: golem-scaffold          # lowercase, unique, no rbx- prefix
description: one or two sentences: what it does and when to use it
enabled: true
---
```

The description is the trigger. When editing a skill, keep both halves: what
the skill does **and** the request shapes that should load it.

## Editing

- Keep the body imperative and testable; prefer checklists over prose.
- Do not duplicate `rbx-debug`, `rbx-unit-test`, `rbx-perf-profiling`, or
  `rbx-docs-search`; hand off to them by name.
- Do not hardcode Golem CLI commands in a way that breaks Studio Assistant.
  Mention them as an alternative for terminal agents.
- Re-run `npx golem-bridge skillpack <name>` after edits to confirm the file
  still parses and the description is intact.

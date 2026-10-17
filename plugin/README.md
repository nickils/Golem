# Golem Studio plugin source

The plugin is a single `Script` (see `VERSION` at the top of `Golem.lua`).

This build ships the session protocol only (`ping`, `debug`, `say`,
`turn_begin`, `turn_end`). Studio tools are added back on top.

- `Golem.lua` — the canonical source. Edit this, then rebuild the model file.
- `Golem.rbxmx` — the installable build: one top-level `Script` named
  `Golem`, `Disabled=false`, with the Lua source in `Source`. Attach this
  file to each GitHub Release; it is also what gets uploaded to the Roblox
  Creator Store.
- `build.py` — wraps `Golem.lua` in the `.rbxmx` XML envelope and
  round-trip-verifies it (`python3 build.py`, needs only the standard library).

Install: drop `Golem.rbxmx` into Studio's `Plugins` folder and restart Studio.

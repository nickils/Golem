#!/usr/bin/env node
"use strict";

// Runs plugin/Golem.lua under fengari against test/plugin-stub.lua.
// This is a construction + behaviour smoke test, not a Studio renderer:
// it proves the plugin builds its UI, switches tabs, runs Luau, inserts
// assets, copies skill prompts, and rejects unknown Instance properties.
//
//   npm install && npm run test:plugin

const path = require("path");
const { lua, lauxlib, lualib, to_luastring } = require("fengari");

const root = path.join(__dirname, "..");
process.chdir(root);

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

const status = lauxlib.luaL_dofile(L, to_luastring(path.join("test", "plugin-stub.lua")));
if (status !== lua.LUA_OK) {
  const message = lua.lua_tojsstring(L, -1);
  console.error(message);
  process.exit(1);
}

// Parses the assembled plugin with fengari's real compiler. fengari is Lua 5.3,
// not Luau, so this catches syntax/structure errors - not Luau type issues.
const fs = require("fs");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");
const src = fs.readFileSync(process.argv[2], "utf8");
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
const status = lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring("=plugin"));
if (status !== lua.LUA_OK) {
  console.error("SYNTAX ERROR: " + to_jsstring(lua.lua_tostring(L, -1)));
  process.exit(1);
}
console.log("OK   " + process.argv[2].split("/").pop());

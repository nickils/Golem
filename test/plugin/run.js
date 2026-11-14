// Runs the plugin test suites against the real plugin source, inside fengari
// with a Roblox shim. No Studio needed - the shim models the API surface the
// plugin actually touches.
//
//   node test/plugin/run.js            # every suite
//   node test/plugin/run.js sweep      # just one
//   node test/plugin/run.js --plugin path/to/Golem.lua
//
// Requires fengari (`npm i --no-save fengari`). It is not a devDependency on
// purpose: `npm test` stays dependency-free for people who only use the CLI.
const fs = require("fs");
const path = require("path");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");

const here = (f) => path.join(__dirname, f);

const args = process.argv.slice(2);
const pluginFlag = args.indexOf("--plugin");
const pluginPath =
  pluginFlag === -1 ? path.join(__dirname, "..", "..", "plugin", "Golem.lua") : args[pluginFlag + 1];
if (pluginFlag !== -1) args.splice(pluginFlag, 2);

const only = args[0] || null;

const read = (f) => fs.readFileSync(here(f), "utf8");

// Each suite is a Lua module `run()` that exercises the plugin through the shim.
const suites = [
  { name: "ui", file: "ui_test.lua", pass: /^UI OK/m },
  { name: "switch", file: "switch_test.lua", pass: /^SWITCH OK/m },
  { name: "restart", file: "restart_test.lua", pass: /^RESTART OK/m },
  { name: "sweep", file: "sweep.lua", pass: /^SWEEP: \d+ ops, 0 errored\/hung/m },
];

function load(L, name, src) {
  const chunk = "@" + name;
  if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring(chunk)) !== lua.LUA_OK) {
    throw new Error("load error in " + name + ": " + to_jsstring(lua.lua_tostring(L, -1)));
  }
  // the suites address chunks as __chunk_shim / __chunk_json / __chunk_plugin
  lua.lua_setglobal(L, to_luastring("__chunk_" + name.replace(/\.lua$/, "").replace(/[^A-Za-z0-9]/g, "_")));
}

function runSuite(suite) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  // Collect what the plugin prints so the suite's own "OK" line can be checked;
  // everything is still echoed so a failure is readable.
  const out = [];
  lua.lua_pushjsfunction(L, function (S) {
    const n = lua.lua_gettop(S);
    const parts = [];
    for (let i = 1; i <= n; i++) parts.push(to_jsstring(lua.lua_tostring(S, i)));
    const line = parts.join("\t");
    out.push(line);
    console.log("    " + line);
    return 0;
  });
  lua.lua_setglobal(L, to_luastring("print"));

  load(L, "shim.lua", read("shim.lua"));
  load(L, "json.lua", read("json.lua"));
  load(L, "plugin", fs.readFileSync(pluginPath, "utf8"));
  load(L, suite.file, read(suite.file));

  const mod = "__chunk_" + suite.file.replace(/\.lua$/, "").replace(/[^A-Za-z0-9]/g, "_");
  const boot = `
local ok, err = xpcall(function() ${mod}().run() end,
  function(e) return debug.traceback(tostring(e), 2) end)
if not ok then
  print("FAILED: " .. tostring(err))
end
`;
  if (lauxlib.luaL_dostring(L, to_luastring(boot)) !== lua.LUA_OK) {
    const err = to_jsstring(lua.lua_tostring(L, -1));
    return { ok: false, why: err };
  }
  // The suite reports a failed assertion by printing FAILED; do not let that
  // read as a pass, and do not let os.exit() swallow the report either.
  const failed = out.find((l) => l.startsWith("FAILED:"));
  if (failed !== undefined) {
    return { ok: false, why: failed.replace(/^FAILED: /, "").split("\n")[0] };
  }
  // A suite that quietly returned without asserting anything must not pass.
  if (!out.some((l) => suite.pass.test(l))) {
    return { ok: false, why: "the suite finished without printing its OK line" };
  }
  return { ok: true, line: out.filter((l) => suite.pass.test(l)).pop() };
}

if (!fs.existsSync(pluginPath)) {
  console.error("no plugin at " + pluginPath);
  process.exit(1);
}

console.log("plugin: " + pluginPath + "\n");
let failures = 0;
const ran = [];
for (const suite of suites) {
  if (only !== null && only !== suite.name) continue;
  ran.push(suite.name);
  console.log("[" + suite.name + "]");
  let result;
  try {
    result = runSuite(suite);
  } catch (err) {
    result = { ok: false, why: String(err && err.message ? err.message : err) };
  }
  if (result.ok) {
    console.log("  PASS  " + result.line + "\n");
  } else {
    failures += 1;
    console.log("  FAIL  " + result.why + "\n");
  }
}

if (ran.length === 0) {
  console.error('no suite named "' + only + '"');
  process.exit(1);
}
console.log(failures === 0
  ? "PLUGIN OK - " + ran.length + "/" + ran.length + " suites"
  : "PLUGIN FAILURES - " + failures + " of " + ran.length + " suites failed");
process.exit(failures === 0 ? 0 : 1);

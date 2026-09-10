"use strict";

// golem-bridge unit tests. Zero dependencies, no network: run with
//   npm test
// (every relay/marketplace test would need Studio or roblox.com, so the
// suite covers parsing, arg-building, validation, and local file state.)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cli = require("./cli.js");

function throwsUsage(fn, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof cli.UsageError, `expected UsageError, got ${err}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test("vec3 parses x,y,z and space-separated triples", () => {
  assert.deepEqual(cli.vec3("1,2,3"), { x: 1, y: 2, z: 3 });
  assert.deepEqual(cli.vec3("1 2 3"), { x: 1, y: 2, z: 3 });
  assert.deepEqual(cli.vec3("-1.5, 0, 4"), { x: -1.5, y: 0, z: 4 });
});

test("vec3 keeps the single-value x-only shorthand", () => {
  assert.deepEqual(cli.vec3("5"), { x: 5, y: 0, z: 0 });
});

test("vec3 rejects garbage", () => {
  for (const bad of ["", "  ", "a,b,c", "1,2", "1,2,3,4", "1,NaN,3", "Infinity,0,0"]) {
    throwsUsage(() => cli.vec3(bad), /bad vector/);
  }
});

test("scalar parses attr values", () => {
  assert.equal(cli.scalar("42"), 42);
  assert.equal(cli.scalar("-7"), -7);
  assert.equal(cli.scalar("4.5"), 4.5);
  assert.equal(cli.scalar("1e3"), 1000);
  assert.equal(cli.scalar("true"), true);
  assert.equal(cli.scalar("false"), false);
  assert.equal(cli.scalar("hello"), "hello");
  assert.equal(cli.scalar("0x10"), "0x10"); // not decimal: stays a string
  assert.equal(cli.scalar(" 42 "), 42);
});

test("stripTimeout splits --timeout out of argv", () => {
  assert.deepEqual(cli.stripTimeout(["--timeout", "5", "a"]), { args: ["a"], timeout: 5 });
  assert.deepEqual(cli.stripTimeout(["a", "--timeout=7.5"]), { args: ["a"], timeout: 7.5 });
  assert.deepEqual(cli.stripTimeout(["a", "b"]), { args: ["a", "b"], timeout: null });
  assert.deepEqual(cli.stripTimeout(["--", "--timeout"]), { args: ["--", "--timeout"], timeout: null });
  for (const bad of ["0", "-3", "abc", "Infinity", "NaN"]) {
    throwsUsage(() => cli.stripTimeout(["--timeout", bad]), /--timeout/);
  }
  throwsUsage(() => cli.stripTimeout(["--timeout=0"]), /--timeout/);
});

test("parseToolArgs applies defaults", () => {
  const ns = cli.parseToolArgs("list", []);
  assert.equal(ns.path, "game");
  assert.equal(ns.recursive, false);
  assert.equal(ns.max, null);
});

test("parseToolArgs handles flags, appends, and --", () => {
  const tag = cli.parseToolArgs("tag", ["P", "--add", "a", "--add=b", "--remove", "c"]);
  assert.deepEqual(tag.add, ["a", "b"]);
  assert.deepEqual(tag.remove, ["c"]);
  const grep = cli.parseToolArgs("grep", ["-i", "pat"]);
  assert.equal(grep.i, true);
  assert.equal(grep.pattern, "pat");
  const lua = cli.parseToolArgs("lua", ["--", "-x"]);
  assert.equal(lua.code, "-x");
  const scale = cli.parseToolArgs("scale", ["P", "-2"]);
  assert.equal(scale.factor, -2); // negative positionals are values, not flags
});

test("parseToolArgs rejects bad flags and arity", () => {
  throwsUsage(() => cli.parseToolArgs("list", ["--nope"]), /unknown flag/);
  throwsUsage(() => cli.parseToolArgs("list", ["-z"]), /unknown flag/);
  throwsUsage(() => cli.parseToolArgs("list", ["--recursive=true"]), /takes no value/);
  throwsUsage(() => cli.parseToolArgs("tree", ["--depth"]), /needs a value/);
  throwsUsage(() => cli.parseToolArgs("tree", ["--depth", "abc"]), /bad integer/);
  throwsUsage(() => cli.parseToolArgs("turn", ["maybe"]), /bad action/);
  throwsUsage(() => cli.parseToolArgs("turn", []), /missing action/);
  throwsUsage(() => cli.parseToolArgs("delete", []), /need at least one/);
  throwsUsage(() => cli.parseToolArgs("move", ["only-one"]), /missing parent/);
  throwsUsage(() => cli.parseToolArgs("say", ["a", "b"]), /too many arguments/);
  throwsUsage(() => cli.parseToolArgs("play", ["--mode", "pause"]), /bad value/);
});

test("buildArgs supports ping and debug (regression: both were 'unknown tool')", () => {
  assert.deepEqual(cli.buildArgs("ping", {}), { op: "ping", args: {} });
  assert.deepEqual(cli.buildArgs("debug", {}), { op: "debug", args: {} });
});

test("every non-local tool has buildArgs support (never 'unknown tool')", () => {
  for (const name of Object.keys(cli.TOOLS)) {
    if (cli.TOOLS[name].local) continue;
    // lua/script read stdin when no code/source is given, so hand them some.
    const ns =
      name === "lua"
        ? { code: "return 1" }
        : name === "script"
          ? { parent: "P", name: "N", cls: "Script", mode: "create", source: "print(1)" }
          : {};
    try {
      const built = cli.buildArgs(name, ns);
      assert.equal(typeof built.op, "string", `${name}: op must be a string`);
    } catch (err) {
      assert.ok(err instanceof cli.UsageError, `${name}: expected UsageError, got ${err}`);
      assert.ok(!/unknown tool/.test(err.message), `${name}: missing buildArgs case`);
    }
  }
});

test("every tool is listed in exactly one help group", () => {
  const grouped = cli.GROUPS.flatMap(([, names]) => names);
  assert.deepEqual(new Set(grouped).size, grouped.length, "a tool is listed twice");
  assert.deepEqual(new Set(Object.keys(cli.TOOLS)), new Set(grouped), "TOOLS and GROUPS disagree");
});

test("buildArgs validates tool arguments instead of sending junk to Studio", () => {
  // tree: --depth 0 is depth 0, not the default (regression: || turned 0 into 2)
  assert.equal(cli.buildArgs("tree", { path: "game", depth: 0 }).args.depth, 0);
  assert.equal(cli.buildArgs("tree", { path: "game", depth: null }).args.depth, 2);
  throwsUsage(() => cli.buildArgs("tree", { path: "game", depth: -1 }), /--depth/);
  // positive-only numeric caps
  for (const [tool, ns] of [
    ["list", { path: "g", max: 0 }],
    ["find", { query: "q", scope: "g", max: -1 }],
    ["grep", { pattern: "p", scope: "g", max: 0 }],
    ["logs", { limit: 0 }],
    ["duplicate", { path: "p", count: 0 }],
    ["scatter", { path: "p", count: 0 }],
  ]) {
    throwsUsage(() => cli.buildArgs(tool, ns), /must be/);
  }
  // scale needs a positive factor
  throwsUsage(() => cli.buildArgs("scale", { path: "p", factor: 0 }), /positive/);
  throwsUsage(() => cli.buildArgs("scale", { path: "p", factor: -2 }), /positive/);
  // rotate needs --set or both --axis and --degrees
  throwsUsage(() => cli.buildArgs("rotate", { path: "p", space: "world" }), /--set/);
  throwsUsage(() => cli.buildArgs("rotate", { path: "p", space: "world", axis: "y" }), /--set/);
  assert.deepEqual(cli.buildArgs("rotate", { path: "p", space: "world", axis: "y", degrees: 90 }).args,
    { path: "p", space: "world", axis: "y", degrees: 90 });
  // paint needs something to paint
  throwsUsage(() => cli.buildArgs("paint", { paths: ["p"] }), /at least one/);
  // selection --set needs a real path (empty used to silently clear the selection)
  throwsUsage(() => cli.buildArgs("selection", { set: "" }), /at least one path/);
  throwsUsage(() => cli.buildArgs("selection", { set: "  " }), /at least one path/);
  // pivot needs something to set
  throwsUsage(() => cli.buildArgs("pivot", { path: "p" }), /--position/);
  // find needs a query or a tag
  throwsUsage(() => cli.buildArgs("find", { query: "", scope: "game" }), /--tag/);
  assert.equal(cli.buildArgs("find", { query: "", scope: "game", tag: "T" }).args.tag, "T");
  // tag needs --add and/or --remove, with non-empty names
  throwsUsage(() => cli.buildArgs("tag", { paths: ["p"] }), /--add/);
  throwsUsage(() => cli.buildArgs("tag", { paths: ["p"], add: [""] }), /must not be empty/);
  // turn end needs its note (the manual calls a missing note a rejection)
  assert.equal(cli.buildArgs("turn", { action: "begin" }).op, "turn_begin");
  throwsUsage(() => cli.buildArgs("turn", { action: "end" }), /--note/);
  throwsUsage(() => cli.buildArgs("turn", { action: "end", note: "" }), /--note/);
  // exec needs a string op
  throwsUsage(() => cli.buildArgs("exec", { json: '{"op":123}' }), /string "op"/);
  throwsUsage(() => cli.buildArgs("exec", { json: "not json" }), /invalid JSON/);
  assert.equal(cli.buildArgs("exec", { json: '{"op":"list","args":{"path":"g"}}' }).op, "list");
  // attr --set needs K=V with a non-empty key
  throwsUsage(() => cli.buildArgs("attr", { path: "p", set: ["nokey"] }), /K=V/);
  throwsUsage(() => cli.buildArgs("attr", { path: "p", set: ["=5"] }), /non-empty key/);
  assert.deepEqual(cli.buildArgs("attr", { path: "p", set: ["A=1", "B=x"] }).args.set, { A: 1, B: "x" });
  // terrain requirements
  throwsUsage(() => cli.buildArgs("terrain", {}), /--position/);
  throwsUsage(
    () => cli.buildArgs("terrain", { action: "fill", shape: "block", position: "0,0,0", material: "Grass" }),
    /--size/
  );
  throwsUsage(
    () => cli.buildArgs("terrain", { action: "fill", shape: "ball", position: "0,0,0", material: "Grass" }),
    /--radius/
  );
});

test("isValidChannel accepts 8-64 hex only", () => {
  assert.equal(cli.isValidChannel("0123456789abcdef"), true);
  assert.equal(cli.isValidChannel("ABCDEF12"), true);
  assert.equal(cli.isValidChannel("a".repeat(64)), true);
  for (const bad of ["", "xyz", "a".repeat(7), "a".repeat(65), "0123456789abcdeg", " 0123456789abcdef ", null, undefined, 123]) {
    assert.equal(cli.isValidChannel(bad), false, JSON.stringify(bad));
  }
});

test("relayBase enforces HTTPS and strips trailing slashes", () => {
  assert.equal(cli.relayBase("https://example.com/"), "https://example.com");
  assert.equal(cli.relayBase("https://example.com///"), "https://example.com");
  assert.equal(cli.relayBase("http://localhost:9000/"), "http://localhost:9000");
  assert.equal(cli.relayBase("http://127.0.0.1:9000/x"), "http://127.0.0.1:9000/x");
  for (const bad of ["http://evil.example.com", "ftp://x", "https-evil.com", "", null]) {
    assert.throws(() => cli.relayBase(bad), /non-HTTPS/);
  }
  // default (no env override in the test process) is the production relay
  if (process.env.GOLEM_FIREBASE_DB === undefined && process.env.AIB_FIREBASE_DB === undefined) {
    assert.equal(cli.relayBase(), "https://roblox-golem-default-rtdb.firebaseio.com");
  }
});

test("loadChannel prefers GOLEM_CHANNEL, then AIB_CHANNEL, then the file", () => {
  const saved = { GOLEM_CHANNEL: process.env.GOLEM_CHANNEL, AIB_CHANNEL: process.env.AIB_CHANNEL };
  try {
    delete process.env.GOLEM_CHANNEL;
    delete process.env.AIB_CHANNEL;
    process.env.AIB_CHANNEL = "aaaaaaaaaaaaaaaa";
    assert.equal(cli.loadChannel(), "aaaaaaaaaaaaaaaa");
    process.env.GOLEM_CHANNEL = "bbbbbbbbbbbbbbbb";
    assert.equal(cli.loadChannel(), "bbbbbbbbbbbbbbbb");
    assert.equal(cli.envChannelName(), "GOLEM_CHANNEL");
    delete process.env.GOLEM_CHANNEL;
    assert.equal(cli.envChannelName(), "AIB_CHANNEL");
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("mpInfo rejects non-numeric asset ids before touching the network", async () => {
  for (const bad of ["12ab", "abc", "", "  ", null, undefined, "rbxassetid://x"]) {
    await assert.rejects(() => cli.mpInfo(bad), /bad asset id/);
  }
});

test("saveChannel writes a 0600 channel file and removeStaleHelpers cleans 2.x leftovers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golem-test-"));
  try {
    const stale = ["golem-helper.py", "golem-tools.md", "golem.py", "golem.md"];
    for (const f of [...stale, "keep.txt"]) fs.writeFileSync(path.join(dir, f), "x");
    const file = cli.saveChannel(dir, "0123456789abcdef");
    assert.equal(file, path.join(dir, "channel"));
    assert.equal(fs.readFileSync(file, "utf8"), "0123456789abcdef\n");
    for (const f of stale) assert.equal(fs.existsSync(path.join(dir, f)), false, f);
    assert.equal(fs.existsSync(path.join(dir, "keep.txt")), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disconnect removes the channel dir (and warns when the env still connects)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golem-test-"));
  const cwd = process.cwd();
  const savedEnv = { GOLEM_CHANNEL: process.env.GOLEM_CHANNEL, AIB_CHANNEL: process.env.AIB_CHANNEL };
  const savedLog = console.log;
  const savedErr = console.error;
  let logged = "";
  let warned = "";
  console.log = (s) => { logged += s; };
  console.error = (s) => { warned += s; };
  try {
    delete process.env.GOLEM_CHANNEL;
    delete process.env.AIB_CHANNEL;
    process.chdir(tmp);
    cli.saveChannel(path.join(tmp, ".golem"), "0123456789abcdef");
    cli.disconnect();
    assert.equal(fs.existsSync(path.join(tmp, ".golem")), false);
    assert.match(logged, /disconnected/);
    process.env.GOLEM_CHANNEL = "bbbbbbbbbbbbbbbb";
    cli.disconnect();
    assert.match(warned, /GOLEM_CHANNEL/);
  } finally {
    console.log = savedLog;
    console.error = savedErr;
    process.chdir(cwd);
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

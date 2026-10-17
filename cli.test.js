"use strict";

// golem-bridge unit tests. Zero dependencies, no network: run with
//   npm test
// (every relay test would need Studio, so the suite covers parsing,
// arg-building, validation, and local file state.)

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

test("parseToolArgs parses positions, flags, and --", () => {
  assert.deepEqual(cli.parseToolArgs("turn", ["begin"]), { action: "begin", note: null });
  assert.deepEqual(cli.parseToolArgs("turn", ["end", "--note", "done"]), { action: "end", note: "done" });
  assert.deepEqual(cli.parseToolArgs("turn", ["end", "--note=done"]), { action: "end", note: "done" });
  assert.deepEqual(cli.parseToolArgs("say", ["hello"]), { text: "hello" });
  assert.deepEqual(cli.parseToolArgs("say", ["--", "-x"]), { text: "-x" });
  assert.deepEqual(cli.parseToolArgs("status", []), {});
});

test("parseToolArgs rejects bad flags and arity", () => {
  throwsUsage(() => cli.parseToolArgs("turn", ["--nope"]), /unknown flag/);
  throwsUsage(() => cli.parseToolArgs("turn", ["end", "--note"]), /needs a value/);
  throwsUsage(() => cli.parseToolArgs("turn", ["maybe"]), /bad action/);
  throwsUsage(() => cli.parseToolArgs("turn", []), /missing action/);
  throwsUsage(() => cli.parseToolArgs("say", []), /missing text/);
  throwsUsage(() => cli.parseToolArgs("say", ["a", "b"]), /too many arguments/);
});

test("buildArgs maps session tools to relay ops", () => {
  assert.deepEqual(cli.buildArgs("ping", {}), { op: "ping", args: {} });
  assert.deepEqual(cli.buildArgs("debug", {}), { op: "debug", args: {} });
  assert.deepEqual(cli.buildArgs("say", { text: "hi" }), { op: "say", args: { text: "hi" } });
  assert.deepEqual(cli.buildArgs("turn", { action: "begin" }), { op: "turn_begin", args: {} });
  assert.deepEqual(cli.buildArgs("turn", { action: "end", note: "done" }), {
    op: "turn_end",
    args: { note: "done" },
  });
});

test("buildArgs rejects a turn end without a note", () => {
  throwsUsage(() => cli.buildArgs("turn", { action: "end" }), /--note/);
  throwsUsage(() => cli.buildArgs("turn", { action: "end", note: "" }), /--note/);
  throwsUsage(() => cli.buildArgs("made-up", {}), /unknown tool/);
});

test("every tool builds and is listed in exactly one help group", () => {
  const fixtures = { say: { text: "hi" }, turn: { action: "begin" } };
  for (const name of Object.keys(cli.TOOLS)) {
    if (cli.TOOLS[name].local) continue;
    const built = cli.buildArgs(name, fixtures[name] || {});
    assert.equal(typeof built.op, "string", `${name}: op must be a string`);
  }
  const grouped = cli.GROUPS.flatMap(([, names]) => names);
  assert.deepEqual(new Set(grouped).size, grouped.length, "a tool is listed twice");
  assert.deepEqual(new Set(Object.keys(cli.TOOLS)), new Set(grouped), "TOOLS and GROUPS disagree");
});

test("the CLI only emits the session-protocol ops", () => {
  const fixtures = { say: { text: "hi" }, turn: { action: "begin" } };
  const ops = Object.keys(cli.TOOLS)
    .filter((name) => !cli.TOOLS[name].local)
    .map((name) => cli.buildArgs(name, fixtures[name] || {}).op)
    .sort();
  assert.deepEqual(ops, ["debug", "ping", "say", "turn_begin"]);
});

test("the manual documents every tool", () => {
  const manual = fs.readFileSync(path.join(__dirname, "golem-tools.md"), "utf8");
  for (const name of Object.keys(cli.TOOLS)) {
    assert.ok(manual.includes(`**${name}**`), `golem-tools.md does not document ${name}`);
  }
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

test("status with no saved channel prints a clean error (no crash)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golem-test-"));
  const cwd = process.cwd();
  const savedEnv = { GOLEM_CHANNEL: process.env.GOLEM_CHANNEL, AIB_CHANNEL: process.env.AIB_CHANNEL };
  const savedErr = console.error;
  const savedCode = process.exitCode;
  let printed = "";
  console.error = (s) => { printed += s; };
  try {
    delete process.env.GOLEM_CHANNEL;
    delete process.env.AIB_CHANNEL;
    process.chdir(tmp);
    await cli.main(["status"]);
    assert.match(printed, /not connected/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = savedErr;
    process.exitCode = savedCode;
    process.chdir(cwd);
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

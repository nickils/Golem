"use strict";

// golem-bridge tests. Zero dependencies, no network:
//   npm test
// Every protocol test talks to test/fake-studio-mcp.js, a stand-in for
// Studio's built-in MCP binary that speaks the same JSON-RPC dialect.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const cli = require("./cli.js");

const CLI = path.join(__dirname, "cli.js");
const FAKE = path.join(__dirname, "test", "fake-studio-mcp.js");
const VERSION = require("./package.json").version;

function run(args, options) {
  const opts = options || {};
  const env = { ...process.env };
  delete env.GOLEM_STUDIO_ID;
  delete env.FAKE_MCP_MODE;
  delete env.GOLEM_STUDIO_MCP;
  delete env.ROBLOX_STUDIO_MCP_BIN;
  if (opts.override !== false) env.GOLEM_STUDIO_MCP = FAKE;
  if (opts.mode) env.FAKE_MCP_MODE = opts.mode;
  Object.assign(env, opts.env || {});
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 30000,
    env,
    input: opts.input === undefined ? "" : opts.input,
  });
  assert.equal(res.error, undefined, `spawn failed: ${res.error && res.error.message}`);
  return res;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "golem-test-"));
}

// ---------------------------------------------------------------- parsing

test("plugin and package versions stay in sync", () => {
  const source = fs.readFileSync(path.join(__dirname, "plugin", "Golem.lua"), "utf8");
  const match = source.match(/^local VERSION = "([^"]+)"/m);
  assert.ok(match, "plugin has a VERSION constant");
  assert.equal(match[1], VERSION);
});

test("skillpack lists and prints the bundled skills", () => {
  const list = run(["skillpack"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /golem-game-brief/);
  assert.match(list.stdout, /golem-scaffold/);
  assert.match(list.stdout, /golem-playtest-qa/);
  assert.match(list.stdout, /rbx-create-skill/);

  const one = run(["skillpack", "golem-scaffold"]);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^---\nname: golem-scaffold/);
  assert.match(one.stdout, /Init -> Start/);

  const parsed = JSON.parse(run(["skillpack", "--json"]).stdout);
  assert.equal(parsed.skills.length, 3);

  assert.equal(run(["skillpack", "nope"]).status, 1);
  assert.equal(run(["skillpack", "../package"]).status, 2);
});

test("bundled skill frontmatter is valid", () => {
  const dir = path.join(__dirname, "skills");
  for (const name of ["golem-game-brief", "golem-scaffold", "golem-playtest-qa"]) {
    const text = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, `${name} has frontmatter`);
    assert.match(match[1], new RegExp(`^name: ${name}$`, "m"));
    assert.match(match[1], /^description: .+$/m);
    assert.match(match[1], /^enabled: true$/m);
    assert.doesNotMatch(match[1], /^name: rbx-/m);
  }
});

test("parseStudios reads the shapes Studio has returned", () => {
  assert.deepEqual(cli.parseStudios({ content: [{ type: "text", text: '{"studios":[]}' }] }), []);
  assert.deepEqual(
    cli.parseStudios({
      content: [{ type: "text", text: '{"studios":[{"id":"abc","name":"Place"}]}' }],
    }),
    [{ id: "abc", name: "Place" }]
  );
  assert.deepEqual(
    cli.parseStudios({ structuredContent: { studios: [{ studio_id: "s1", place_name: "One" }] } }),
    [{ id: "s1", name: "One" }]
  );
  assert.deepEqual(cli.parseStudios({ content: [{ type: "text", text: '["raw-id"]' }] }), [
    { id: "raw-id", name: "" },
  ]);
  assert.deepEqual(cli.parseStudios({ content: [{ type: "text", text: "not json" }] }), []);
  assert.deepEqual(cli.parseStudios({}), []);
});

test("resolveStudio picks, matches names, and refuses ambiguity", () => {
  const one = [{ id: "a", name: "Alpha" }];
  const two = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];
  assert.equal(cli.resolveStudio(one), "a");
  assert.equal(cli.resolveStudio(two, "b"), "b");
  assert.equal(cli.resolveStudio(two, "Beta"), "b");
  assert.equal(cli.resolveStudio(two, "bet"), "b");
  assert.throws(() => cli.resolveStudio(two), /several Studio windows/);
  assert.throws(() => cli.resolveStudio(two, "zzz"), /no Studio matches/);
  assert.throws(() => cli.resolveStudio([], "a"), /no Studio instance/);
});

test("tokenSet normalizes tool names", () => {
  assert.deepEqual([...cli.tokenSet("search_game_tree")].sort(), ["game", "search", "tree"]);
  assert.deepEqual([...cli.tokenSet("searchGameTree")].sort(), ["game", "search", "tree"]);
});

test("parseFlags validates options", () => {
  const spec = { limit: { type: "int" }, file: { type: "str" }, client: { type: "bool" } };
  const flags = cli.parseFlags(["--limit", "5", "--file=x.luau", "--client", "pos"], spec);
  assert.equal(flags.limit, 5);
  assert.equal(flags.file, "x.luau");
  assert.equal(flags.client, true);
  assert.deepEqual(flags._pos, ["pos"]);
  assert.equal(cli.parseFlags(["--", "--limit"], spec)._pos[0], "--limit");
  assert.throws(() => cli.parseFlags(["--nope"], spec), cli.UsageError);
  assert.throws(() => cli.parseFlags(["--limit", "abc"], spec), /integer/);
  assert.throws(() => cli.parseFlags(["--timeout", "0"], spec), /positive/);
  assert.throws(() => cli.parseFlags(["--wait", "-1"], spec), /positive number/);
  assert.throws(() => cli.parseFlags(["--client=true"], spec), /takes no value/);
});

test("buildArgs maps logical names onto the live schema", () => {
  const tool = {
    name: "execute_luau",
    inputSchema: {
      type: "object",
      properties: { luau: { type: "string" }, studio_id: { type: "string" } },
      required: ["luau", "studio_id"],
    },
  };
  assert.deepEqual(cli.buildArgs(tool, { code: "print(1)" }, "s1"), { luau: "print(1)", studio_id: "s1" });
  assert.throws(() => cli.buildArgs(tool, { code: "x" }, null), /needs studio_id/);
  assert.throws(() => cli.buildArgs(tool, {}, "s1"), /needs luau/);
  assert.throws(() => cli.buildArgs(tool, { query: "x" }, "s1"), /does not accept 'query'/);
});

test("resolveTool falls back to token matching", () => {
  const tools = [{ name: "search_game_tree", inputSchema: { properties: { path: {} } } }];
  assert.equal(cli.resolveTool(tools, ["searchGameTree"]).name, "search_game_tree");
  assert.throws(() => cli.resolveTool(tools, ["insert_asset"]), /does not expose/);
});

// ---------------------------------------------------------------- cli surface

test("help, version, and command help", () => {
  const help = run(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Connection:/);
  assert.match(help.stdout, /Marketplace:/);
  assert.match(help.stdout, /Skills:/);

  assert.equal(run(["--version"]).stdout.trim(), VERSION);

  const cmd = run(["help", "run"]);
  assert.equal(cmd.status, 0);
  assert.match(cmd.stdout, /Usage: npx golem-bridge run/);
  assert.match(cmd.stdout, /--datamodel/);
});

test("unknown commands and flags exit 2", () => {
  const unknown = run(["frobnicate"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/);

  assert.equal(run(["status", "--nope"]).status, 2);
  assert.equal(run(["reconnect"]).status, 2);
  assert.match(run(["connect", "secret-channel"]).stderr, /takes no channel id/);
});

test("manual prints the agent reference", () => {
  const res = run(["manual"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Roblox Studio tools/);
  assert.match(res.stdout, /rbx-debug/);
  assert.match(res.stdout, /Rules of the road/);
});

// ---------------------------------------------------------------- connection

test("connect --brief handshakes and lists the studio", () => {
  const res = run(["connect", "--brief"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Handshake: FakeStudioMCP 9\.9\.9/);
  assert.match(res.stdout, /Tools: 15/);
  assert.match(res.stdout, /Studio: studio-abc {2}Test Place/);
  assert.match(res.stdout, /connected\./);
  assert.doesNotMatch(res.stdout, /Roblox Studio tools/);
});

test("connect prints the manual after a successful handshake", () => {
  const res = run(["connect"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Roblox Studio tools/);
  assert.match(res.stdout, /Marketplace/);
});

test("status and studios report the live session", () => {
  const status = run(["status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /^CONNECTED {2}FakeStudioMCP 9\.9\.9 {2}15 tools {2}studio-abc \(Test Place\)/);

  assert.equal(run(["ping"]).status, 0);
  const studios = run(["studios", "--json"]);
  assert.deepEqual(JSON.parse(studios.stdout).studios, [{ id: "studio-abc", name: "Test Place" }]);
});

test("no studio attached is a clear failure, not a crash", () => {
  const res = run(["connect", "--wait", "0"], { mode: "nostudio" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Studio did not attach/);
  assert.match(res.stdout, /Enable Studio as MCP server/);
  assert.doesNotMatch(res.stdout, /Roblox Studio tools/);
});

test("late attach is retried within the wait window", () => {
  const quick = run(["connect", "--brief", "--wait", "0"], { mode: "late" });
  assert.equal(quick.status, 1);

  const slow = run(["connect", "--brief"], { mode: "late" });
  assert.equal(slow.status, 0, slow.stderr);
  assert.match(slow.stdout, /connected\./);
});

test("several windows require an explicit choice", () => {
  const ambiguous = run(["run", "print(1)"], { mode: "multi" });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /several Studio windows/);
  assert.match(ambiguous.stderr, /studio-2 {2}Second Place/);

  const chosen = run(["run", "--studio", "Second", "print(1)"], { mode: "multi" });
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stdout, /studio=studio-2/);
});

test("a missing Studio binary explains the platform", () => {
  if (process.platform === "win32" || process.platform === "darwin") return;
  const res = run(["status"], { override: false });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /only available on macOS and Windows/);
});

test("a crashing MCP binary surfaces stderr-free exit", () => {
  const res = run(["status"], { mode: "crash" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Studio MCP (closed|could not send)/);
});

test("a silent tools/list times out instead of hanging", () => {
  const res = run(["status", "--timeout", "1"], { mode: "silent" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no response to 'tools\/list' within 1s/);
});

// ---------------------------------------------------------------- tools

test("tools follows pagination and prints schemas", () => {
  const all = run(["tools"]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /execute_luau/);
  assert.match(all.stdout, /screen_capture/);
  assert.match(all.stdout, /multi_edit/);

  const one = run(["tools", "execute_luau"]);
  assert.equal(one.status, 0);
  assert.match(one.stdout, /arguments: code\*: string/);
  assert.match(one.stdout, /"datamodel_type"/);

  const missing = run(["tools", "nope"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /unknown Studio tool/);
});

// ---------------------------------------------------------------- luau

test("run executes in Edit by default and routes to the studio", () => {
  const res = run(["run", "print(1 + 1)"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "datamodel=Edit\nstudio=studio-abc\ncode=print(1 + 1)\n");
});

test("run supports client, server, file, and stdin", () => {
  assert.match(run(["run", "--client", "print(1)"]).stdout, /datamodel=Client/);
  assert.match(run(["run", "--server", "print(1)"]).stdout, /datamodel=Server/);
  assert.match(run(["run", "--datamodel=Client", "print(1)"]).stdout, /datamodel=Client/);

  const dir = tmpdir();
  const file = path.join(dir, "code.luau");
  fs.writeFileSync(file, "print('from file')\n");
  assert.match(run(["run", "--file", file]).stdout, /code=print\('from file'\)/);

  assert.match(run(["run", "-"], { input: "print('stdin')\n" }).stdout, /code=print\('stdin'\)/);
});

test("run rejects empty code and bad datamodels", () => {
  assert.equal(run(["run"]).status, 2);
  assert.match(run(["run", "   "]).stderr, /non-empty Luau code/);
  assert.equal(run(["run", "--datamodel", "Workspace", "x"]).status, 2);
  assert.equal(run(["run", "--file", "/nonexistent/x.luau"]).status, 1);
});

test("run reports tool errors as failures", () => {
  const res = run(["run", "error('x')"], { mode: "toolerror" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /boom: Luau failed/);
});

// ---------------------------------------------------------------- marketplace

test("search defaults to every asset kind and forwards filters", () => {
  const plain = run(["search", "chair"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).type, "All");

  const res = run(["search", "tree", "--type", "model", "--scope", "inventory", "--limit", "5"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { query: "tree", type: "Model", scope: "inventory", limit: 5 });

  assert.equal(JSON.parse(run(["search", "logo", "--type", "image"]).stdout).type, "Image");
  assert.equal(JSON.parse(run(["search", "boom", "--type", "AUDIO"]).stdout).type, "Audio");
  assert.equal(JSON.parse(run(["search", "chair", "--type", "all"]).stdout).type, "All");

  const bad = run(["search", "chair", "--type", "spaceship"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not an accepted asset_type/);
  assert.match(bad.stderr, /Model, Image, Audio/);
});

test("search validates input", () => {
  assert.equal(run(["search"]).status, 2);
  assert.match(run(["search", "x", "--limit", "0"]).stderr, /positive integer/);
  assert.match(run(["search", "x", "--limit", "1.5"]).stderr, /must be an integer/);
});

test("insert normalizes asset ids", () => {
  const res = run(["insert", "rbxassetid://123456"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "inserted 123456 under Selection");

  const parented = run(["insert", "42", "--parent", "Workspace.Props"]);
  assert.match(parented.stdout, /inserted 42 under Workspace\.Props/);

  assert.equal(run(["insert", "abc"]).status, 2);
});

// ---------------------------------------------------------------- skills

test("skills lists the classic set and asks Studio", () => {
  const res = run(["skills"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /rbx-create-skill/);
  assert.match(res.stdout, /rbx-perf-profiling/);
  assert.match(res.stdout, /rbx-unit-test/);
  assert.match(res.stdout, /skills: rbx-debug, rbx-unit-test/);

  const json = run(["skills", "--json"]);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.classic.length, 7);
  assert.equal(parsed.studio.content[0].text, "skills: rbx-debug, rbx-unit-test");
});

test("skill loads one skill by name", () => {
  const res = run(["skill", "rbx-debug"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "SKILL:rbx-debug");
});

// ---------------------------------------------------------------- raw tools

test("call passes arguments and injects studio_id", () => {
  const res = run(["call", "inspect_instance", '{"path":"Workspace.Baseplate"}']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    res.stdout.trim(),
    'inspect_instance({"path":"Workspace.Baseplate","studio_id":"studio-abc"})'
  );

  const luau = run(["call", "execute_luau", '{"code":"print(2)"}']);
  assert.match(luau.stdout, /code=print\(2\)/);
  assert.match(luau.stdout, /studio=studio-abc/);
});

test("call validates the tool and its required arguments", () => {
  assert.equal(run(["call"]).status, 2);
  assert.equal(run(["call", "nope", "{}"]).status, 1);

  const missing = run(["call", "execute_luau", "{}"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /execute_luau needs code/);

  assert.equal(run(["call", "execute_luau", "not json"]).status, 2);
  assert.equal(run(["call", "execute_luau", '{"code":"x","studio_id":"zzz"}']).status, 1);
  assert.match(run(["call", "execute_luau"]).stderr, /needs code/);
});

test("json mode returns the raw MCP result", () => {
  const res = run(["run", "--json", "print(1)"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.content[0].type, "text");
  assert.match(parsed.content[0].text, /code=print\(1\)/);
});

test("screenshot writes returned image blocks", () => {
  const dir = tmpdir();
  const out = path.join(dir, "viewport.png");
  const res = run(["screenshot", "--out", out]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), "PNGDATA");
  assert.match(res.stdout, /viewport\.png/);
});

// ---------------------------------------------------------------- compatibility

test("legacy Studio schemas resolve at runtime", () => {
  const luau = run(["run", "print(1)"], { mode: "legacy" });
  assert.equal(luau.status, 0, luau.stderr);
  assert.match(luau.stdout, /datamodel=Edit/);
  assert.match(luau.stdout, /code=print\(1\)/);

  const search = run(["search", "tree"], { mode: "legacy" });
  assert.equal(search.status, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).query, "tree");

  const insert = run(["insert", "99"], { mode: "legacy" });
  assert.match(insert.stdout, /inserted 99/);

  const skill = run(["skill", "rbx-unit-test"], { mode: "legacy" });
  assert.equal(skill.stdout.trim(), "SKILL:rbx-unit-test");
});

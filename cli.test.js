"use strict";

// golem-bridge unit tests. Zero dependencies, no network: run with
//   npm test
// These cover parsing, arg building, the PNG writer, the turn token, the local
// broker (against a fake plugin on loopback), and the plugin source itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");

const cli = require("./cli.js");

function throwsUsage(fn, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof cli.UsageError, `expected UsageError, got ${err}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

// Tests that touch .golem must not litter the repo.
function inTempCwd(fn) {
  return async () => {
    const before = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golem-test-"));
    process.chdir(dir);
    try {
      await fn(dir);
    } finally {
      process.chdir(before);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
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

test("scalar parses attribute values", () => {
  assert.equal(cli.scalar("42"), 42);
  assert.equal(cli.scalar("-7"), -7);
  assert.equal(cli.scalar("4.5"), 4.5);
  assert.equal(cli.scalar("1e3"), 1000);
  assert.equal(cli.scalar("true"), true);
  assert.equal(cli.scalar("false"), false);
  assert.equal(cli.scalar("hello"), "hello");
  assert.equal(cli.scalar("0x10"), "0x10");
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
});

test("parseSetupLine accepts the v4 line, the bare secret, and quoted forms", () => {
  const secret = "0123456789abcdef0123456789abcdef01234567";
  for (const input of [
    `npx golem-bridge connect ${secret}`,
    `${secret}`,
    `  "npx golem-bridge connect ${secret}"  `,
    `npx  golem-bridge  connect  ${secret}`,
  ]) {
    assert.deepEqual(cli.parseSetupLine(input), { secret }, input);
  }
  assert.deepEqual(cli.parseSetupLine(`npx golem-bridge connect ${secret} --port 42000`), {
    secret,
    port: 42000,
  });
  for (const bad of ["", "golem-bridge", "short", "zzzz:0123456789abcdef", `${secret} --port 0`]) {
    assert.equal(cli.parseSetupLine(bad), null, bad);
  }
});

test("a 3.x line is refused instead of half-working", () => {
  // old lines carried a relay channel: accepting them would silently fail
  assert.deepEqual(cli.parseSetupLine("aabbccdd11223344"), { legacy: "channel" });
  assert.deepEqual(
    cli.parseSetupLine("aabbccdd11223344:0123456789abcdef0123456789abcdef01234567"),
    { legacy: "pair" }
  );
});

test("the setup line never leaks into a tool argument", () => {
  // a tool must not be able to spell a variable that looks like the link
  const built = cli.buildArgs("count", cli.parseToolArgs("count", []));
  assert.deepEqual(built, { op: "count", args: { scope: "game" } });
});

test("parseToolArgs fills defaults and validates choices", () => {
  assert.deepEqual(cli.parseToolArgs("count", []), { scope: "game", cls: null });
  assert.deepEqual(cli.parseToolArgs("read", ["Workspace/Part"]), { path: "Workspace/Part", json: false, props: null });
  throwsUsage(() => cli.buildArgs("tree", cli.parseToolArgs("tree", ["game", "--depth", "-1"])), /depth/);
  throwsUsage(() => cli.parseToolArgs("count", ["game", "--nope"]), /unknown flag/);
  throwsUsage(() => cli.parseToolArgs("play", ["--mode", "fast"]), /bad value/);
});

test("buildArgs maps the new playtesting tools", () => {
  assert.deepEqual(cli.buildArgs("play", cli.parseToolArgs("play", [])), {
    op: "play",
    args: { mode: "play" },
  });
  assert.deepEqual(cli.buildArgs("click", cli.parseToolArgs("click", ["10", "20"])), {
    op: "click",
    args: { x: 10, y: 20, button: "left" },
  });
  assert.deepEqual(cli.buildArgs("input", cli.parseToolArgs("input", ["w", "space"])), {
    op: "input",
    args: { keys: ["w", "space"] },
  });
  assert.deepEqual(cli.buildArgs("screenshot", cli.parseToolArgs("screenshot", ["--label", "menu"])), {
    op: "screenshot",
    args: { label: "menu" },
    screenshot: true,
    label: "menu",
  });
  assert.deepEqual(cli.buildArgs("undo", cli.parseToolArgs("undo", ["--times", "3"])), {
    op: "undo",
    args: { times: 3 },
  });
  throwsUsage(() => cli.parseToolArgs("input", []), /at least one key/);
  throwsUsage(() => cli.buildArgs("click", cli.parseToolArgs("click", ["a", "b"])), /must be numbers/);
});

test("there is no turn/say/note tool left", () => {
  for (const gone of ["say", "turn", "turn_begin", "turn_end"]) {
    assert.equal(cli.TOOLS[gone], undefined, `${gone} should be gone`);
  }
  assert.ok(cli.TOOLS.play && cli.TOOLS.screenshot && cli.TOOLS.click && cli.TOOLS.input);
  assert.ok(cli.TOOLS.look_through && cli.TOOLS.playstate);
});

test("every advertised tool builds args without throwing", () => {
  // a tool listed in help but unmapped in buildArgs is a broken release
  const samples = {
    ping: [], debug: [], exec: ['{"op":"ping"}'], lua: ["return 1"], list: ["game"], tree: ["game"],
    read: ["Workspace/X"], find: ["Part"], grep: ["foo"], script: ["ServerScriptService", "S", "--source", "x"],
    delete: ["Workspace/X"], move: ["Workspace/X", "Workspace"], selection: [], waypoint: [],
    rotate: ["Workspace/X", "--degrees", "90", "--axis", "y"], face: ["Workspace/X", "0,0,0"],
    shift: ["Workspace/X", "0,1,0"], scale: ["Workspace/X", "2"], duplicate: ["Workspace/X"],
    group: ["Workspace/X"], pivot: ["Workspace/X", "--position", "0,0,0"], place: ["Workspace/X", "0,0,0"],
    paint: ["Workspace/X", "--color", "#fff"], rename: ["Workspace/X", "Y"], look: ["Workspace/X"],
    count: [], undo: [], redo: [], anchor: ["Workspace/X"], collide: ["Workspace/X"],
    light: ["Workspace/X"], sound: ["Workspace", "123"], weld: ["Workspace/X"], hitbox: ["Workspace/X"],
    prompt: ["Workspace/X"], particles: ["Workspace/X"], sign: ["--text", "hi"],
    beam: ["Workspace/A", "Workspace/B"], trail: ["Workspace/X"], explosion: ["Workspace/X"],
    scatter: ["Workspace/X"], ui_screen: ["Hud"], ui_frame: ["StarterGui", "F"],
    ui_label: ["StarterGui", "L"], ui_button: ["StarterGui", "B"], ui_input: ["StarterGui", "I"],
    ui_image: ["StarterGui", "Img"], ui_list: ["StarterGui"], play: [], stop: [], playstate: [],
    logs: [], screenshot: [], click: ["1", "2"], input: ["space"], look_through: ["Workspace/X"],
    attr: ["Workspace/X"], tag: ["Workspace/X", "--add", "T"],
    terrain: ["--position", "0,0,0", "--size", "1,1,1"], insert: ["123"], apply: ["123", "Workspace/X", "Texture"],
  };
  for (const name of Object.keys(cli.TOOLS)) {
    if (cli.TOOLS[name].local) continue;
    assert.ok(samples[name], `no sample for ${name}`);
    const built = cli.buildArgs(name, cli.parseToolArgs(name, samples[name]));
    assert.ok(built && typeof built.op === "string", `${name} did not build an op`);
  }
  // and every tool in the help groups exists
  for (const [, names] of cli.GROUPS) {
    for (const n of names) assert.ok(cli.TOOLS[n], `${n} listed but missing from TOOLS`);
  }
});

test("decodeRgbaCsv + encodePng produce a real PNG", () => {
  const rgba = cli.decodeRgbaCsv("255,0,0,255;0,255,0,255;0,0,255,255;255,255,255,255", 2, 2);
  assert.equal(rgba.length, 16);
  assert.deepEqual([...rgba.slice(0, 4)], [255, 0, 0, 255]);
  const png = cli.encodePng(2, 2, rgba);
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // the IDAT payload must inflate back to filter bytes + pixels
  const idatStart = png.indexOf(Buffer.from("IDAT", "ascii")) + 4;
  const idatLen = png.readUInt32BE(idatStart - 8);
  const raw = zlib.inflateSync(png.slice(idatStart, idatStart + idatLen));
  assert.equal(raw.length, (2 * 4 + 1) * 2);
  assert.equal(raw[0], 0); // filter byte
  assert.deepEqual([...raw.slice(1, 5)], [255, 0, 0, 255]);
});

test("writeScreenshot writes into .golem/shots and names the file", inTempCwd(async () => {
  const shot = cli.writeScreenshot(
    { width: 2, height: 2, pixels: "1,2,3,255;4,5,6,255;7,8,9,255;10,11,12,255", label: "my shot" },
    undefined
  );
  assert.ok(fs.existsSync(shot.file), shot.file);
  assert.match(path.basename(shot.file), /^my-shot-.*\.png$/);
  assert.ok(shot.file.includes(`${path.sep}.golem${path.sep}shots${path.sep}`));
  throwsUsage;
  assert.throws(() => cli.writeScreenshot({ pixels: "" }), /usable size/);
}));

test("currentTurn keeps a burst in one turn and starts a new one later", inTempCwd(() => {
  const first = cli.currentTurn();
  const second = cli.currentTurn();
  assert.equal(second.token, first.token, "back-to-back calls share a turn");
  const forced = cli.currentTurn({ newTurn: true });
  assert.notEqual(forced.token, first.token, "a new request opens a new turn");
  // the token is what the plugin stamps onto each command, so it must be a token
  assert.match(forced.token, /^t[0-9a-z]+$/);
}));

// --------------------------------------------------------------- fake plugin
// A tiny stand-in for the Studio plugin: links, then long-polls and answers.
let keepAliveRef = null;

function startFakePlugin(port, opts) {
  const o = opts || {};
  const secret = o.secret || "0123456789abcdef0123456789abcdef01234567";
  const device = "golem-abcdef01";
  const state = { linked: false, polls: 0, commands: [], results: [] };
  let stopped = false;
  const request = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: p,
          method,
          headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              resolve({});
            }
          });
        }
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });

  const keepAlive = setInterval(() => {}, 1 << 30);
  keepAliveRef = keepAlive;
  const loop = (async () => {
    while (!stopped) {
      if (!state.linked) {
        try {
          const r = await request("POST", "/v1/session", {
            deviceId: device,
            secret,
            place: "Test Place",
            pluginVersion: "4.0.0",
          });
          state.linked = r && r.ok === true;
        } catch {
          // bridge not up yet
        }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      let batch;
      try {
        batch = await request("GET", `/v1/poll?device=${device}&secret=${secret}&wait=600`);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      state.polls += 1;
      for (const cmd of batch.commands || []) {
        state.commands.push(cmd);
        const result =
          cmd.op === "screenshot"
            ? { ok: true, width: 1, height: 1, format: "rgba-csv", pixels: "9,8,7,255", source: "editor" }
            : { echoed: cmd.args };
        const envelope = {
          id: cmd.id,
          op: cmd.op,
          ok: true,
          result,
          turn: cmd.turn ? 1 : 0,
          turnTools: 1,
        };
        state.results.push(envelope);
        await request("POST", "/v1/result", { result: envelope });
      }
    }
  })();

  return {
    state,
    secret,
    device,
    requests: request,
    stop: async () => {
      stopped = true;
      return loop;
    },
  };
}

test("broker: a fake plugin links, runs a command, and reports the turn", async () => {
  const port = 45871;
  const link = { secret: "0123456789abcdef0123456789abcdef01234567", port };
  const { server } = await cli.startBroker(link);
  const plugin = startFakePlugin(port, { secret: link.secret });
  try {
    // wait for the link
    const linkDeadline = Date.now() + 4000;
    while (!cli.broker.deviceId && Date.now() < linkDeadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(cli.broker.deviceId, "golem-abcdef01");

    const call = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ op: "count", args: { scope: "game" }, secret: link.secret, turn: "tabc" });
      const req = http.request(
        { host: "127.0.0.1", port, path: "/v1/call", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    assert.equal(call.ok, true, JSON.stringify(call));
    assert.deepEqual(call.result, { echoed: { scope: "game" } });
    assert.equal(plugin.state.commands[0].op, "count");
    assert.equal(plugin.state.commands[0].turn, "tabc", "the turn token must reach the plugin");
  } finally {
    await plugin.stop();
    clearInterval(keepAliveRef);
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 200));
  }
});

test("broker: a wrong secret is refused, and a guest call reaches the game driver", async () => {
  const port = 45872;
  const link = { secret: "ffffffffffffffffffffffffffffffffffffffff", port };
  const { server } = await cli.startBroker(link);
  const post = (p, body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  try {
    const denied = await post("/v1/call", { op: "ping", secret: "nope" });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /unauthorized/);

    // simulate the in-game driver: it polls for work and answers it
    const driver = (async () => {
      for (let i = 0; i < 40; i++) {
        const work = await post("/v1/guest/exec", { role: "client", op: "poll" });
        const cmd = work.result && work.result.commands && work.result.commands[0];
        if (cmd) {
          await post("/v1/guest/exec", {
            role: "client",
            op: "result",
            args: { id: cmd.id, ok: true, result: { clicked: cmd.args } },
          });
          return cmd;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })();
    // the plugin asks the bridge to run something inside the game
    const fromPlugin = post("/v1/guest/exec", { role: "client", op: "click", args: { x: 3, y: 4 }, timeoutMs: 5000 });
    const seen = await driver;
    assert.ok(seen, "the in-game driver never received the click");
    assert.equal(seen.op, "click");
    assert.deepEqual(seen.args, { x: 3, y: 4 });
    const answer = await fromPlugin;
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.result, { clicked: { x: 3, y: 4 } });
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 200));
  }
});

test("status explains what to do when nothing is listening", async () => {
  const before = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golem-status-"));
  process.chdir(dir);
  const savedPort = process.env.GOLEM_PORT;
  process.env.GOLEM_PORT = "45899";
  try {
    const s = await cli.status();
    assert.equal(s.ok, false);
    assert.match(s.error, /connect|setup line/);
  } finally {
    if (savedPort === undefined) delete process.env.GOLEM_PORT;
    else process.env.GOLEM_PORT = savedPort;
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- plugin
test("the shipped plugin source is v4 and has no relay left", () => {
  const file = path.join(__dirname, "plugin", "Golem.lua");
  const src = fs.readFileSync(file, "utf8");
  assert.match(src, /local VERSION = "4\.0\.0"/);
  assert.ok(!/firebaseio\.com/.test(src), "a Firebase relay URL is still in the plugin");
  assert.ok(!/parse\.app|PROXY_URL/.test(src), "a hosted proxy fallback is still in the plugin");
  assert.ok(!/\/v1\/inbox\//.test(src), "the relay's inbox endpoints are still in the plugin");
  assert.ok(!/function OPS\.say/.test(src), "the note system is still in the plugin");
  assert.ok(!/turn_begin|turn_end/.test(src), "the old turn ops are still in the plugin");
  assert.match(src, /TryBeginRecording/, "the revert fix is missing");
  assert.match(src, /ExecutePlayModeAsync/, "play must start a real test session");
  assert.match(src, /CreateVirtualInput/, "input tools need virtual input");
  assert.match(src, /CaptureScreenshot/, "screenshot needs CaptureService");
  // the wrong-role call that started this whole rewrite must be gone
  assert.ok(!/guestExec\("editor"/.test(src), "screenshot must not ask for a nonexistent editor driver");
});

test("every op the CLI can send exists in the plugin", () => {
  const src = fs.readFileSync(path.join(__dirname, "plugin", "Golem.lua"), "utf8");
  const ops = new Set([...src.matchAll(/^function OPS\.([a-z_0-9]+)/gm)].map((m) => m[1]));
  const sent = new Set();
  for (const name of Object.keys(cli.TOOLS)) {
    if (cli.TOOLS[name].local) continue;
    // every op buildArgs can produce for this tool
    const spec = cli.TOOLS[name];
    const samples = {
      ping: [], debug: [], exec: ['{"op":"ping"}'], lua: ["return 1"], list: [], tree: [], read: ["Workspace/X"],
      find: ["Part"], grep: ["x"], script: ["ServerScriptService", "S", "--source", "x"],
      delete: ["Workspace/X"], move: ["Workspace/X", "Workspace"], selection: [], waypoint: [],
      rotate: ["Workspace/X", "--axis", "y", "--degrees", "1"], face: ["Workspace/X", "0,0,0"],
      shift: ["Workspace/X", "0,0,0"], scale: ["Workspace/X", "2"], duplicate: ["Workspace/X"],
      group: ["Workspace/X"], pivot: ["Workspace/X", "--position", "0,0,0"], place: ["Workspace/X", "0,0,0"],
      paint: ["Workspace/X", "--color", "#fff"], rename: ["Workspace/X", "Y"], look: ["Workspace/X"],
      count: [], undo: [], redo: [], anchor: ["Workspace/X"], collide: ["Workspace/X"],
      light: ["Workspace/X"], sound: ["Workspace", "1"], weld: ["Workspace/X"], hitbox: ["Workspace/X"],
      prompt: ["Workspace/X"], particles: ["Workspace/X"], sign: ["--text", "hi"],
      beam: ["Workspace/A", "Workspace/B"], trail: ["Workspace/X"], explosion: ["Workspace/X"],
      scatter: ["Workspace/X"], ui_screen: ["Hud"], ui_frame: ["StarterGui", "F"],
      ui_label: ["StarterGui", "L"], ui_button: ["StarterGui", "B"], ui_input: ["StarterGui", "I"],
      ui_image: ["StarterGui", "Img"], ui_list: ["StarterGui"], play: [], stop: [], playstate: [],
      logs: [], screenshot: [], click: ["1", "1"], input: ["space"], look_through: ["Workspace/X"],
      attr: ["Workspace/X"], tag: ["Workspace/X", "--add", "T"],
      terrain: ["--position", "0,0,0", "--size", "1,1,1"], insert: ["1"], apply: ["1", "Workspace/X", "Texture"],
    };
    const built = cli.buildArgs(name, cli.parseToolArgs(name, samples[name] || []));
    sent.add(built.op);
  }
  for (const op of sent) {
    assert.ok(ops.has(op), `the CLI can send '${op}' but the plugin has no OPS.${op}`);
  }
});

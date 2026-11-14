"use strict";

// golem-bridge unit tests. Zero dependencies, no network: run with
//   npm test
// These cover parsing, arg building, the PNG writer, the turn token, the relay
// transport (against a local stub speaking the Firebase REST shape), and the
// plugin source itself.

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

test("parseSetupLine accepts the 3.x-style line, the bare channel, and quoted forms", () => {
  const channel = "a1b2c3d4e5f60718";
  for (const input of [
    `npx golem-bridge connect ${channel}`,
    `${channel}`,
    `  "npx golem-bridge connect ${channel}"  `,
    `npx  golem-bridge  connect  ${channel}`,
    `Connect to my Roblox Studio, Run: npx golem-bridge connect ${channel}`,
    channel.toUpperCase(),
  ]) {
    assert.deepEqual(cli.parseSetupLine(input), { channel }, input);
  }
  // the id goes into a URL, so anything that is not hex is refused outright
  for (const bad of ["", "golem-bridge", "short", "zzzzzzzzzzzzzzzz", "a1b2-c3d4", `${channel} --port 0`]) {
    assert.equal(cli.parseSetupLine(bad), null, bad);
  }
});

test("channel ids are validated before they reach a URL", () => {
  assert.equal(cli.isValidChannel("a1b2c3d4e5f60718"), true);
  for (const bad of ["", "abc", "../channels", "a1b2c3d4e5f60718/../../x", "a".repeat(80), null]) {
    assert.equal(cli.isValidChannel(bad), false, String(bad));
  }
});

test("a 40-char 4.x secret parses as an id, so a stale line fails at the ping", () => {
  // 4.x had no channel at all; a 4.x secret is hex and is treated as an id, so
  // the ping is what tells the user the line is stale - not a silent success
  const parsed = cli.parseSetupLine("npx golem-bridge connect " + "0".repeat(40));
  assert.deepEqual(parsed, { channel: "0".repeat(40) });
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
  // --max-width is always sent now: the plugin needs it to size the capture,
  // and a width that cannot fit the relay is rejected before the round trip.
  const shotDefault = cli.TOOLS.screenshot.flags.max_width[1].default;
  assert.deepEqual(cli.buildArgs("screenshot", cli.parseToolArgs("screenshot", ["--label", "menu"])), {
    op: "screenshot",
    args: { label: "menu", maxWidth: shotDefault },
    screenshot: true,
    label: "menu",
  });
  assert.deepEqual(
    cli.buildArgs("screenshot", cli.parseToolArgs("screenshot", ["--max-width", "320"])).args,
    { maxWidth: 320 },
    "--max-width must reach the plugin"
  );
  assert.deepEqual(cli.buildArgs("undo", cli.parseToolArgs("undo", ["--times", "3"])), {
    op: "undo",
    args: { times: 3 },
  });
  // Flags are declared snake_case but read camelCase. Both spellings now exist,
  // so these five can no longer be silently dropped on the way to the plugin.
  assert.equal(cli.buildArgs("click", cli.parseToolArgs("click", ["1", "2", "--hold-ms", "150"])).args.holdMs, 150);
  assert.equal(cli.buildArgs("input", cli.parseToolArgs("input", ["w", "--key-delay", "0.2"])).args.keyDelay, 0.2);
  assert.equal(cli.buildArgs("input", cli.parseToolArgs("input", ["w", "--hold-seconds", "1.5"])).args.holdSeconds, 1.5);
  assert.equal(cli.buildArgs("scatter", cli.parseToolArgs("scatter", ["Workspace/X", "--y-jitter", "2"])).args.yJitter, 2);
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

// ------------------------------------------------------------- relay stub
// A minimal stand-in for the Firebase Realtime Database REST API: push-style
// POST under /channels/<id>/cmd.json, shallow key listings, per-key GETs. Keys
// are monotonic so the CLI's sinceKey filtering is exercised for real.
function startRelayStub(opts) {
  const o = opts || {};
  const state = {
    channels: new Map(), // id -> { cmd: Map, res: Map, beacons: Map }
    posts: [],
    gets: [],
    rateLimitFirstPolls: o.rateLimitFirstPolls || 0,
    polls: 0,
    onCommand: o.onCommand || null,
    stopped: false,
  };
  const chan = (id) => {
    if (!state.channels.has(id)) state.channels.set(id, { cmd: new Map(), res: new Map(), beacons: new Map() });
    return state.channels.get(id);
  };
  let counter = 0;
  const nextKey = () => {
    counter += 1;
    return `-k${String(counter).padStart(8, "0")}`;
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://relay");
      const body = Buffer.concat(chunks).toString();
      const send = (status, obj, headers) => {
        res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, headers || {}));
        res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
      };
      // NOTE: the key group must not swallow the ".json" suffix
      const m = url.pathname.match(/^\/channels\/([^/]+)\/(cmd|res|beacons)(?:\/([^/.]+))?(?:\.json)?$/);
      if (!m) return send(404, { error: "not found" });
      const [, id, bucket, key] = m;
      const box = chan(id)[bucket];

      if (req.method === "POST") {
        state.posts.push({ id, bucket, body });
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: "bad json" });
        }
        const k = nextKey();
        box.set(k, parsed);
        if (bucket === "cmd") {
          // the plugin side: answer on the next tick, as a real plugin would
          if (state.onCommand) {
            setTimeout(() => {
              const reply = state.onCommand(parsed, id);
              if (reply) chan(id).res.set(nextKey(), reply);
            }, 10);
          }
        }
        return send(200, { name: k });
      }

      if (key) {
        state.gets.push({ id, bucket, key });
        const v = box.get(key);
        return send(200, v === undefined ? "null" : v);
      }

      if (bucket === "res" && url.searchParams.get("shallow") === "true") {
        state.polls += 1;
        if (state.polls <= state.rateLimitFirstPolls) {
          return send(429, { error: "rate limited" }, { "Retry-After": "0" });
        }
        const out = {};
        for (const k of box.keys()) out[k] = true;
        return send(200, Object.keys(out).length ? out : "null");
      }
      const out = {};
      for (const [k, v] of box.entries()) out[k] = v;
      return send(200, Object.keys(out).length ? out : "null");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        chan,
        nextKey,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// The relay must be https except for a local stub, so the tests point the
// override at loopback and everything else goes through relayCall unchanged.
async function withRelayStub(opts, fn) {
  const stub = await startRelayStub(opts);
  const saved = process.env.GOLEM_FIREBASE_DB;
  const savedPoll = process.env.GOLEM_POLL_INTERVAL;
  process.env.GOLEM_FIREBASE_DB = stub.url;
  if (!savedPoll) process.env.GOLEM_POLL_INTERVAL = "0.25";
  try {
    await fn(stub);
  } finally {
    if (saved === undefined) delete process.env.GOLEM_FIREBASE_DB;
    else process.env.GOLEM_FIREBASE_DB = saved;
    if (savedPoll === undefined) delete process.env.GOLEM_POLL_INTERVAL;
    else process.env.GOLEM_POLL_INTERVAL = savedPoll;
    await stub.close();
  }
}

const CHAN = "a1b2c3d4e5f60718";

test("relay: a command is posted with its own key and its reply is matched by id", async () => {
  await withRelayStub(
    {
      onCommand: (cmd) => ({ id: cmd.id, ok: true, result: { echoed: cmd.args, turn: 1, turnTools: 1 } }),
    },
    async (stub) => {
      // a stale reply already in the channel must never be taken for ours
      stub.chan(CHAN).res.set("-k00000000", { id: "somebody-else", ok: true, result: { wrong: true } });
      const answer = await cli.relayCall(CHAN, "count", { scope: "game" }, 20);
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.deepEqual(answer.result, { echoed: { scope: "game" }, turn: 1, turnTools: 1 });
      const posted = JSON.parse(stub.state.posts[0].body);
      assert.equal(posted.op, "count");
      assert.deepEqual(posted.args, { scope: "game" });
      assert.match(posted.id, /^c[0-9a-z]+$/);
      assert.ok(posted.ts > 0, "every command carries a timestamp the plugin can skip on");
      assert.match(answer.id, /^c/);
      assert.equal(stub.state.posts[0].bucket, "cmd");
    }
  );
});

test("relay: an encoded result is unwrapped and a bad channel never hits the network", async () => {
  await withRelayStub(
    {
      onCommand: (cmd) => {
        // the plugin JSON-encodes oversized results; the CLI must undo that
        const big = { rows: Array.from({ length: 5 }, (_, i) => i) };
        return { id: cmd.id, ok: true, result: JSON.stringify(big), resultEncoded: true, v: "4.0.0" };
      },
    },
    async (stub) => {
      const answer = await cli.relayCall(CHAN, "list", {}, 20);
      assert.deepEqual(answer.result, { rows: [0, 1, 2, 3, 4] });
      assert.equal(answer.resultEncoded, undefined, "the encoding flag must not leak to the caller");
      const before = stub.state.posts.length;
      const bad = await cli.relayCall("../../evil", "ping", {}, 5);
      assert.equal(bad.ok, false);
      assert.match(bad.error, /bad channel/);
      assert.equal(stub.state.posts.length, before, "an invalid id must not produce a request");
    }
  );
});

test("relay: a 429 on the first poll backs off and still delivers the answer", async () => {
  await withRelayStub(
    {
      rateLimitFirstPolls: 2,
      onCommand: (cmd) => ({ id: cmd.id, ok: true, result: { survived: true } }),
    },
    async () => {
      const answer = await cli.relayCall(CHAN, "ping", {}, 25);
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.deepEqual(answer.result, { survived: true });
    }
  );
});

test("relay: silence becomes a timeout message that names the next step", async () => {
  await withRelayStub({ onCommand: () => null }, async () => {
    const started = Date.now();
    const answer = await cli.relayCall(CHAN, "count", {}, 2);
    assert.equal(answer.ok, false);
    assert.match(answer.error, /timed out after 2s/);
    assert.match(answer.error, /Studio/);
    assert.ok(Date.now() - started >= 1900, "the timeout must actually wait");
  });
});

test("relay: a plugin error is passed through untouched", async () => {
  await withRelayStub(
    { onCommand: (cmd) => ({ id: cmd.id, ok: false, error: "no such instance: Workspace/Nope" }) },
    async () => {
      const answer = await cli.relayCall(CHAN, "read", { path: "Workspace/Nope" }, 20);
      assert.equal(answer.ok, false);
      assert.match(answer.error, /no such instance/);
    }
  );
});

test("relay: the base URL must be https unless it is a local stub", () => {
  const saved = process.env.GOLEM_FIREBASE_DB;
  try {
    delete process.env.GOLEM_FIREBASE_DB;
    assert.match(cli.relayBase(), /^https:\/\//);
    process.env.GOLEM_FIREBASE_DB = "http://relay.example.com/";
    assert.throws(() => cli.relayBase(), /non-HTTPS/);
    process.env.GOLEM_FIREBASE_DB = "http://127.0.0.1:9000/";
    assert.equal(cli.relayBase(), "http://127.0.0.1:9000", "trailing slash trimmed, local allowed");
  } finally {
    if (saved === undefined) delete process.env.GOLEM_FIREBASE_DB;
    else process.env.GOLEM_FIREBASE_DB = saved;
  }
});

test("relay: a live hello beacon reads as live, a revoked one as rotated", async () => {
  await withRelayStub({}, async (stub) => {
    const savedCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golem-status-"));
    process.chdir(dir);
    try {
      cli.saveLink({ channel: CHAN, place: "Test Place" });
      // empty channel: no beacon, no results
      const empty = await cli.status();
      assert.equal(empty.ok, true);
      assert.match(empty.verdict, /never posted here|older plugin/);

      const now = Math.floor(Date.now() / 1000);
      const box = stub.chan(CHAN);
      box.beacons.set("-b1", { op: "hello", ts: now - 5, v: "4.0.0", place: "Test Place" });
      const live = await cli.status();
      assert.match(live.verdict, /LIVE/);
      assert.equal(live.beacon.op, "hello");

      // a rotated channel is not a dead plugin: the verdict must say so
      box.beacons.set("-b2", { op: "revoked", ts: now, v: "4.0.0" });
      const rotated = await cli.status();
      assert.match(rotated.verdict, /ROTATED/);
      assert.match(rotated.verdict, /reconnect/);
    } finally {
      process.chdir(savedCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("status without a saved channel says how to connect", async () => {
  const savedCwd = process.cwd();
  const savedEnv = process.env.GOLEM_CHANNEL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golem-status-"));
  process.chdir(dir);
  delete process.env.GOLEM_CHANNEL;
  try {
    const s = await cli.status();
    assert.equal(s.ok, false);
    assert.match(s.error, /connect/);
  } finally {
    if (savedEnv !== undefined) process.env.GOLEM_CHANNEL = savedEnv;
    process.chdir(savedCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the saved link is only a channel - the id is the whole capability", inTempCwd(async (dir) => {
  const saved = cli.saveLink({ channel: CHAN, place: "Test Place" });
  const data = JSON.parse(fs.readFileSync(saved, "utf8"));
  assert.equal(data.channel, CHAN);
  assert.ok(!("secret" in data), "no second credential may be persisted");
  const link = cli.loadLink();
  assert.equal(link.channel, CHAN);
  // GOLEM_CHANNEL overrides the file, so a sandbox can pin a session
  process.env.GOLEM_CHANNEL = "ffffffffffffffff";
  try {
    assert.equal(cli.loadLink().channel, "ffffffffffffffff");
    process.env.GOLEM_CHANNEL = "not hex";
    assert.equal(cli.loadLink().channel, CHAN, "a junk override is ignored, not obeyed");
  } finally {
    delete process.env.GOLEM_CHANNEL;
  }
}));

// ------------------------------------------------------------------- plugin
test("the shipped plugin talks over the relay and keeps the session capability", () => {
  const file = path.join(__dirname, "plugin", "Golem.lua");
  const src = fs.readFileSync(file, "utf8");
  assert.match(src, /local VERSION = "4\.0\.0"/);
  // the transport a cloud agent can actually use
  assert.match(src, /roblox-golem-default-rtdb\.firebaseio\.com/, "the relay URL is missing");
  assert.match(src, /\/channels\//, "no channel path");
  assert.match(src, /function relayDeliver/, "no result publish path");
  assert.match(src, /function relayLoop|task\.spawn\(relayLoop/, "nothing polls the channel");
  assert.match(src, /orderBy=/, "the command poll must only ask for new keys");
  assert.match(src, /DELETE/, "handled commands must be deleted so they never run twice");
  assert.match(src, /op = "revoked"|"revoked"/, "a retired channel must announce itself");
  // the old localhost broker is gone for good
  assert.ok(!/127\.0\.0\.1:/.test(src), "the loopback broker is still in the plugin");
  assert.ok(!/GOLEM_PORT|DEFAULT_PORT/.test(src), "port plumbing is still in the plugin");
  assert.ok(!/Golem_BridgeHost/.test(src), "the tunnel setting is still in the plugin");
  // the channel id is the capability: minted per session, never persisted
  assert.ok(!/SetSetting\("Golem_Channel",\s*bridge\.channel/.test(src),
    "the session channel is persisted - a pasted line would never expire");
  assert.match(src, /function rotateChannel/, "ending a session must mint a new channel");
  assert.match(src, /randomHex\(16\)/, "channels must be 16 random hex chars");
  assert.ok(!/function OPS\.say/.test(src), "the note system is still in the plugin");
  assert.ok(!/turn_begin|turn_end/.test(src), "the old turn ops are still in the plugin");
  assert.match(src, /TryBeginRecording/, "the revert fix is missing");
  assert.match(src, /ExecutePlayModeAsync/, "play must start a real test session");
  assert.match(src, /CreateVirtualInput/, "input tools need virtual input");
  assert.match(src, /CaptureScreenshot/, "screenshot needs CaptureService");
  assert.ok(!/guestExec\("editor"/.test(src), "screenshot must not ask for a nonexistent editor driver");
});

test("screenshot: the default capture fits the relay, and the size is derived", () => {
  // A 900px RGBA capture is ~5 MB of "r,g,b,a;" text; the relay rejects that, so
  // the advertised default must be a width that actually survives the trip.
  const width = cli.TOOLS.screenshot.flags.max_width[1].default;
  const height = Math.ceil((width * 3) / 4);
  // Worst case, not average: every pixel at full brightness. Sizing on the
  // average 11 bytes is exactly the mistake that shipped a 5 MB "safe" default.
  const worst = width * height * 17;
  assert.ok(
    worst <= 3480000,
    `a bright ${width}px capture is ${Math.round(worst / 1024)}KB, over the relay cap`
  );
  assert.ok(width >= 480, `default ${width}px is smaller than it needs to be`);

  // And the same check on a real saturated payload: encode a full-white capture
  // the way the plugin does and measure it.
  const cell = "255,255,255,255";
  const sample = [];
  for (let i = 0; i < 1000; i++) sample.push(cell);
  const perPixel = sample.join(";").length / 1000;
  assert.ok(
    width * height * perPixel <= 3480000,
    `saturated capture uses ${perPixel} B/px and would be rejected in transit`
  );

  // The CLI must refuse a width it cannot deliver rather than let it die in
  // transit, and the message must say why.
  throwsUsage(
    () => cli.buildArgs("screenshot", cli.parseToolArgs("screenshot", ["--max-width", "1200"])),
    /fit through the relay/
  );

  // The plugin derives the same number from its own cap; if they drift, one side
  // asks for a capture the other cannot deliver.
  const src = fs.readFileSync(path.join(__dirname, "plugin", "Golem.lua"), "utf8");
  assert.match(src, /SCREENSHOT_MAX_WIDTH = best/, "the plugin no longer derives its capture width");

  // Derive the plugin's cap from its own constants and require the two sides to
  // agree: otherwise the CLI asks for a capture the plugin will not deliver, or
  // the plugin sends one the CLI cannot read.
  const cap = Number(/local RELAY_MAX_RESULT = (\d+)/.exec(src)?.[1]);
  const pluginPerPixel = Number(/local BYTES_PER_PIXEL_MAX = (\d+)/.exec(src)?.[1]);
  assert.ok(cap && pluginPerPixel, "the plugin's screenshot sizing constants are gone");
  let pluginWidth = 8;
  for (let w = 8; w <= 2000; w++) {
    if (w * Math.ceil((w * 3) / 4) * pluginPerPixel <= cap - 20000) pluginWidth = w;
  }
  assert.equal(
    width,
    pluginWidth,
    `CLI default ${width}px and plugin cap ${pluginWidth}px disagree - one side cannot deliver`
  );
  // And the plugin's own worst case must clear the transport guard.
  assert.ok(
    pluginWidth * Math.ceil((pluginWidth * 3) / 4) * pluginPerPixel < cap,
    "the plugin would reject its own capture"
  );
});

test("screenshot: a captured PNG decodes back to the pixels that were sent", inTempCwd(async () => {
  // A gradient 8x4 capture, as the plugin emits it ("r,g,b,a;" per pixel).
  const w = 8, h = 4;
  const px = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px.push(`${x * 30},${y * 60},${(x + y) * 20},255`);
  }
  const shot = cli.writeScreenshot({ width: w, height: h, pixels: px.join(";"), label: "grad" }, undefined);
  const png = fs.readFileSync(shot.file);
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = png.indexOf(Buffer.from("IHDR", "ascii")) + 4;
  assert.equal(png.readUInt32BE(ihdr), w, "PNG width must match the capture");
  assert.equal(png.readUInt32BE(ihdr + 4), h, "PNG height must match the capture");
  // inflate the IDAT and check real pixel values survived the round trip
  const idat = png.indexOf(Buffer.from("IDAT", "ascii")) + 4;
  const raw = zlib.inflateSync(png.slice(idat, idat + png.readUInt32BE(idat - 8)));
  const stride = w * 4;
  // row 2, column 5 -> r = 150, g = 120, b = 140
  const off = 2 * (stride + 1) + 1 + 5 * 4;
  assert.deepEqual([...raw.slice(off, off + 4)], [150, 120, 140, 255]);
  assert.equal(raw[0], 0, "each PNG row must start with a filter byte");
}));

test("the play gate covers exactly the ops that work while a test runs", () => {
  const src = fs.readFileSync(path.join(__dirname, "plugin", "Golem.lua"), "utf8");
  const block = src.match(/local PLAY_SAFE = \{([^}]*)\}/);
  assert.ok(block, "the plugin has no PLAY_SAFE table");
  const safe = new Set(block[1].match(/[a-z_0-9]+\s*=/g).map((m) => m.replace(/\s*=$/, "")));
  // These must never be refused mid-test, or playtesting is impossible:
  for (const op of ["play", "stop", "playstate", "screenshot", "click", "input", "look_through", "logs"]) {
    assert.ok(safe.has(op), `'${op}' is refused while the game runs, so it cannot be tested`);
  }
  // ...and nothing that edits the place may be waved through:
  for (const op of ["create", "delete", "script", "lua", "insert_asset", "terrain", "undo"]) {
    assert.ok(!safe.has(op), `'${op}' edits the place but is allowed during a play test`);
  }
  // every name in the gate must be a real op, or the gate has grown weeds
  const ops = new Set([...src.matchAll(/^function OPS\.([a-z_0-9]+)/gm)].map((m) => m[1]));
  for (const op of safe) assert.ok(ops.has(op), `PLAY_SAFE names '${op}', which is not an op`);
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

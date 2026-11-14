#!/usr/bin/env node
"use strict";

// golem-bridge: drive a live Roblox Studio session from any AI agent.
//
// Studio and this CLI meet at a small Firebase Realtime Database relay: the
// plugin can only make outgoing calls, and the agent running these commands is
// often a cloud sandbox that cannot reach the user's machine. The relay stores
// JSON and nothing else - the channel id is the whole capability.

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");

let VERSION = "unknown";
try {
  VERSION = require("./package.json").version || "unknown";
} catch {
  // running outside the package dir; version is informational only
}

function envOf(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

const PLUGIN_STALE_MS = 20000;
const DEFAULT_TIMEOUT = 120;
// One AI request = one turn. Tools called in a burst share a turn token, so
// the very first call of a request already opens (and reports) its turn.
const TURN_IDLE_MS = Math.max(30000, (parseFloat(envOf("GOLEM_TURN_IDLE")) || 300) * 1000);
// Device ids are minted by the plugin ("golem-" + hex) and are public.

class UsageError extends Error {}

function fail(message, exitCode) {
  console.error(`golem-bridge error: ${message}`);
  process.exit(exitCode || 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ workspace
// Everything golem-bridge remembers between calls lives in ./.golem so a
// project can be linked to one Studio session.

function golemDir() {
  return path.join(process.cwd(), ".golem");
}

function linkFile() {
  return path.join(golemDir(), "link.json");
}

function turnFile() {
  return path.join(golemDir(), "turn.json");
}

function shotsDir() {
  return path.join(golemDir(), "shots");
}

function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function writeJsonFile(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: mode || 0o600 });
  try {
    fs.chmodSync(file, mode || 0o600);
  } catch {
    // filesystems without unix permissions
  }
}

// Leftovers from the 3.x relay/Python era. They carry a dead channel id or a
// relay URL; keeping them would only confuse the next run.
const STALE_FILES = ["channel", "golem-helper.py", "golem.py"];

function removeStaleHelpers(dir) {
  for (const stale of STALE_FILES) {
    try {
      fs.rmSync(path.join(dir, stale), { force: true });
    } catch {
      // cleanup must never block a connect
    }
  }
}

function loadLink() {
  // the env override exists so a script or a sandbox can pin a session
  const fromEnv = envOf("GOLEM_CHANNEL", "AIB_CHANNEL");
  if (fromEnv && isValidChannel(String(fromEnv).trim())) {
    return { channel: String(fromEnv).trim(), fromEnv: true };
  }
  const data = readJsonFile(linkFile());
  if (!data || !isValidChannel(String(data.channel || ""))) return null;
  return {
    channel: data.channel,
    place: data.place,
    placeId: data.placeId,
    pluginVersion: data.pluginVersion,
    savedAt: data.savedAt,
  };
}

function saveLink(link) {
  removeStaleHelpers(golemDir());
  const data = Object.assign({}, link, { savedAt: new Date().toISOString(), savedAtMs: Date.now() });
  delete data.fromEnv;
  writeJsonFile(linkFile(), data);
  return linkFile();
}

function requireLink() {
  const link = loadLink();
  if (!link) {
    out({
      ok: false,
      error:
        "not connected - run the setup line shown in the Golem window in Studio: npx golem-bridge connect <channelId>",
    });
    return null;
  }
  return link;
}

/**
 * Accepts the line from the Studio window - "npx golem-bridge connect <id>",
 * with or without a "Connect to my Roblox Studio, Run:" prefix and any
 * surrounding quotes - or the bare 16-char channel id. The id is the secret, so
 * anything that is not hex is rejected rather than pasted into a URL.
 */
function parseSetupLine(text) {
  const raw = String(text == null ? "" : text).trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  const cleaned = raw
    .replace(/^connect\s+to\s+my\s+roblox\s+studio,?\s*/i, "")
    .replace(/^run:?\s*/i, "")
    .replace(/^npx\s+golem-bridge\s+connect\s+/i, "")
    .replace(/^golem-bridge\s+connect\s+/i, "")
    .trim();
  const m = cleaned.match(/^([0-9a-fA-F]{8,64})$/);
  if (!m) return null;
  return { channel: m[1].toLowerCase() };
}

// ---------------------------------------------------------------- turn tokens
// The plugin draws one "Turn: N" header per AI request. The CLI decides when a
// request starts: a tool call after a quiet gap begins a new turn, and calls in
// the same burst keep using it. That way the first call of a request already
// lands in the new turn instead of the previous one.

function currentTurn(options) {
  const force = options && options.newTurn;
  const now = Date.now();
  const saved = readJsonFile(turnFile()) || {};
  const last = Number(saved.lastAt) || 0;
  let token = typeof saved.token === "string" ? saved.token : null;
  if (force || !token || now - last > TURN_IDLE_MS) {
    token = `t${now.toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  }
  const data = { token, lastAt: now, startedAt: token === saved.token ? saved.startedAt || now : now };
  try {
    writeJsonFile(turnFile(), data);
  } catch {
    // a read-only cwd must not break tool calls
  }
  return data;
}

// -------------------------------------------------------------------- output
function out(data, opts) {
  const o = opts || {};
  if (data && data.ok) {
    if (o.rawField && !o.asJson) {
      const result = data.result || {};
      if (typeof result[o.rawField] === "string") {
        process.stdout.write(result[o.rawField]);
        if (!result[o.rawField].endsWith("\n")) process.stdout.write("\n");
        turnReminder(data);
        process.exitCode = 0;
        return;
      }
    }
    console.log(JSON.stringify(data, null, 2));
    turnReminder(data);
    process.exitCode = 0;
    return;
  }
  console.error(JSON.stringify(data, null, 2));
  turnReminder(data);
  process.exitCode = 1;
}

// The turn is already open when the first tool runs, so there is no "start a
// turn" step left to forget. This note only tells the AI which turn it is in.
function turnReminder(entry) {
  if (!entry || entry.turn == null) return;
  const tools = typeof entry.turnTools === "number" ? entry.turnTools : null;
  const suffix = tools == null ? "" : ` (${tools} tool${tools === 1 ? "" : "s"} so far)`;
  console.error(`>> Turn ${entry.turn}${suffix}. When this request is finished, reply to the user - the turn closes itself.`);
}

// ------------------------------------------------------------------ firebase
// The relay. Studio and this CLI both reach a Firebase Realtime Database, which
// is the only place they can meet: Studio can only make outgoing calls, and a
// cloud agent cannot see the user's localhost. Firebase is a message box, not a
// participant - it stores JSON and knows nothing about Roblox.
//
//   channels/<id>/cmd      this CLI writes commands here
//   channels/<id>/res      Studio writes results here
//   channels/<id>/beacons  Studio says hello / revoked, for diagnostics
//
// The channel id is the capability: 16 random hex characters, minted fresh
// every Studio session, wiped when Studio closes or the user ends the session.

const FIREBASE_DB = envOf("GOLEM_FIREBASE_DB", "AIB_FIREBASE_DB") || "https://roblox-golem-default-rtdb.firebaseio.com";
const FETCH_TIMEOUT_MS = 30000;
// A screenshot reply is the biggest thing on the wire: the plugin caps captures
// so they fit ~3.5 MB, and this must stay comfortably above that or a valid
// capture is rejected while it is being read.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
function pollIntervalMs() {
  const secs = parseFloat(envOf("GOLEM_POLL_INTERVAL", "AIB_POLL_INTERVAL")) || 2;
  return Math.max(100, secs * 1000);
}
// Channel ids are 16 hex chars today; tolerate 8-64 for forward compatibility.
// Anything else is rejected so a malformed id can never alter the request URL.
const CHANNEL_RE = /^[0-9a-fA-F]{8,64}$/;

// Screenshots travel as "r,g,b,a;" text, so a pixel costs up to 17 bytes
// ("255,255,255,255;"). Sizing from the average 11 B instead is a trap that
// actually bit us: a bright capture came out 5 MB and the relay rejected it, so
// the "safe" default never arrived. This uses the worst case, keeps room for the
// envelope, and is also the ceiling - a wider capture is just a bigger picture
// that dies on the way home. The plugin derives the same number.
const RELAY_RESULT_BUDGET = 3500000 - 20000;
// Worst case: every pixel at full brightness and opaque. Saturation, so this
// holds for any picture, not just a dark one.
const MAX_BYTES_PER_PIXEL = 17; // "255,255,255,255;" = 16 chars + separator
const DEFAULT_SHOT_WIDTH = (() => {
  let best = 8;
  for (let width = 8; width <= 2000; width++) {
    const height = Math.ceil((width * 3) / 4);
    if (width * height * MAX_BYTES_PER_PIXEL <= RELAY_RESULT_BUDGET) best = width;
  }
  return best;
})();

/**
 * The relay must be HTTPS (plain HTTP only for a local emulator). Trailing
 * slashes are trimmed so URL joins stay clean.
 */
function relayBase(url) {
  // read the env override on every call: a test or a wrapper may set it late
  const configured = envOf("GOLEM_FIREBASE_DB", "AIB_FIREBASE_DB") || FIREBASE_DB || "";
  const raw = String(url !== undefined ? url : configured).replace(/\/+$/, "");
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(raw)) return raw;
  if (!/^https:\/\//.test(raw)) {
    throw new Error(
      `refusing to talk to a non-HTTPS relay (${raw || "(empty)"}) - check GOLEM_FIREBASE_DB/AIB_FIREBASE_DB`
    );
  }
  return raw;
}

function isTooLarge(err) {
  return !!err && typeof err.message === "string" && err.message.includes("response too large");
}

function parseRetryAfter(headers, fallback) {
  try {
    const v = parseFloat(headers.get("retry-after"));
    if (Number.isFinite(v) && v >= 0) return v;
  } catch {
    // fall through
  }
  return fallback;
}

async function fetchText(url, opts) {
  const o = opts || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: o.method || (o.body === undefined ? "GET" : "POST"),
      headers: Object.assign({ Accept: "application/json" }, o.headers || {}),
      body: o.body,
      signal: ctrl.signal,
      redirect: "error", // responses must come from the relay itself
    });
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error("response too large, refusing to parse it");
    }
    return { ok: res.ok, status: res.status, headers: res.headers, text };
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`request timed out (${(o.timeoutMs || FETCH_TIMEOUT_MS) / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isValidChannel(id) {
  return typeof id === "string" && CHANNEL_RE.test(id);
}

/**
 * Send one command and wait for Studio's reply.
 *
 * Writes to /cmd (Firebase assigns the key, so a command can never collide or
 * overwrite a previous one), then polls /res with a shallow read and fetches
 * only the entries newer than the last key seen. That keeps polling cheap: the
 * shallow read is a few bytes no matter how large the results are.
 */
async function relayCall(channelId, op, args, timeoutSec) {
  let base;
  try {
    base = relayBase();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!isValidChannel(channelId)) {
    return { ok: false, error: "bad channel id - copy the setup line from the Studio window" };
  }
  const enc = encodeURIComponent(channelId);
  const cmdId = `c${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;
  const payload = JSON.stringify({ id: cmdId, op, args: args || {}, ts: Math.floor(Date.now() / 1000) });
  // The relay answers a POST with the push key it minted. Result keys are push
  // keys too, so anything at or below ours was written before this command and
  // cannot be its reply - skip it and keep each poll to one small GET.
  let sinceKey = null;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetchText(`${base}/channels/${enc}/cmd.json`, { method: "POST", body: payload });
    } catch (err) {
      return { ok: false, error: `cannot reach the relay (${err.message}) - check internet/DNS` };
    }
    if (r.status === 429 && attempt < 3) {
      await sleep(parseRetryAfter(r.headers, 5 * (attempt + 1)) * 1000);
      continue;
    }
    if (!r.ok) {
      return { ok: false, error: `relay rejected the command: HTTP ${r.status}: ${r.text.slice(0, 200)}` };
    }
    try {
      sinceKey = (JSON.parse(r.text) || {}).name || null;
    } catch {
      sinceKey = null;
    }
    break;
  }
  const deadline = Date.now() + timeoutSec * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    let r;
    try {
      r = await fetchText(`${base}/channels/${enc}/res.json?shallow=true`, { timeoutMs: 60000 });
    } catch (err) {
      if (isTooLarge(err)) {
        return {
          ok: false,
          error: "the result channel is too large to poll - ask the user to restart Studio to rotate to a fresh channel",
        };
      }
      attempt++;
      await sleep(Math.min(15, 0.5 * 2 ** Math.min(attempt, 5)) * 1000);
      continue;
    }
    if (r.status === 429) {
      await sleep(parseRetryAfter(r.headers, 6) * 1000);
      continue;
    }
    if (!r.ok) {
      await sleep(2000);
      continue;
    }
    attempt = 0;
    let keys;
    try {
      keys = r.text === "null" ? {} : JSON.parse(r.text);
    } catch {
      keys = {};
    }
    if (keys && typeof keys === "object") {
      for (const key of Object.keys(keys).sort()) {
        if (sinceKey !== null && !(key > sinceKey)) continue;
        let entry;
        try {
          const er = await fetchText(`${base}/channels/${enc}/res/${encodeURIComponent(key)}.json`, {
            timeoutMs: 60000,
          });
          if (!er.ok) continue; // transient: retry this key on the next poll
          entry = JSON.parse(er.text);
        } catch (err) {
          if (isTooLarge(err)) {
            return {
              ok: false,
              error: `Studio's reply to '${op}' exceeded the relay size cap - narrow the query (path, depth, max)`,
            };
          }
          continue; // transient or corrupt entry: retry this key on the next poll
        }
        if (entry && entry.id === cmdId) {
          if (entry.resultEncoded && typeof entry.result === "string") {
            try {
              entry.result = JSON.parse(entry.result);
            } catch {
              // keep the raw string
            }
            delete entry.resultEncoded;
          }
          return entry;
        }
      }
    }
    await sleep(pollIntervalMs());
  }
  return {
    ok: false,
    error: `timed out after ${timeoutSec}s waiting for Studio to answer '${op}'. Is Roblox Studio open with the Golem plugin, and does its window say connected?`,
  };
}

/**
 * Diagnostics without Studio: read the beacon cache and count cached results.
 * This is how "the plugin is alive but not answering" gets distinguished from
 * "Studio is closed" or "the channel was rotated".
 */
async function status() {
  const channel = loadLink();
  if (!channel || !isValidChannel(channel.channel)) {
    return { ok: false, error: "not connected (no channel saved) - run: npx golem-bridge connect <channelId>" };
  }
  let beaconData;
  let resKeys;
  try {
    const base = relayBase();
    const enc = encodeURIComponent(channel.channel);
    const bb = await fetchText(
      `${base}/channels/${enc}/beacons.json?orderBy=${encodeURIComponent('"$key"')}&limitToLast=5`,
      { timeoutMs: 30000 }
    );
    beaconData = bb.text === "null" ? {} : JSON.parse(bb.text);
    if (typeof beaconData !== "object" || beaconData === null) beaconData = {};
    const rb = await fetchText(`${base}/channels/${enc}/res.json?shallow=true`, { timeoutMs: 30000 });
    resKeys = rb.text === "null" ? {} : JSON.parse(rb.text);
    if (typeof resKeys !== "object" || resKeys === null) resKeys = {};
  } catch (err) {
    return { ok: false, error: `cannot read the relay channel: ${err.message}` };
  }
  const results = Object.values(resKeys).filter((v) => v === true).length;
  const beacons = Object.values(beaconData)
    .filter((e) => e && (e.op === "hello" || e.op === "revoked"))
    .map((e) => [parseFloat(e.ts) || 0, e]);
  if (!beacons.length) {
    const verdict = results
      ? `no beacons, but ${results} cached result(s) - Studio is not running or runs an older plugin; ask the user to restart Studio with the current plugin`
      : "the channel is empty - the plugin has never posted here: Studio is closed, or the setup line is from an older Studio session";
    return { ok: true, beacon: null, ageSeconds: null, recentResults: results, verdict };
  }
  beacons.sort((a, b) => a[0] - b[0]);
  const [ts, beacon] = beacons[beacons.length - 1];
  const age = ts > 0 ? Math.max(0, Math.floor(Date.now() / 1000 - ts)) : null;
  const ver = beacon.v || "?";
  if (beacon.op === "revoked") {
    const ago = age === null ? "" : age < 120 ? ` ${age}s ago` : ` ${Math.floor(age / 60)} min ago`;
    return {
      ok: true,
      beacon,
      ageSeconds: age,
      recentResults: results,
      verdict: `this channel was ROTATED${ago} - Studio wiped it (END SESSION or restart) and minted a new one; ask the user for the fresh setup line and run: npx golem-bridge reconnect <newId>`,
    };
  }
  const verdict =
    age === null
      ? `last beacon has no timestamp (v${ver}) - ask the user to check the Golem window`
      : age <= 900
        ? `plugin is LIVE (v${ver}, hello beacon ${age}s ago) - it should answer commands`
        : `last hello was ${Math.floor(age / 60)} min ago (v${ver}) - Studio may be closed or hung since then; ask the user to check the Golem window`;
  return { ok: true, beacon, ageSeconds: age, recentResults: results, verdict };
}

// ---------------------------------------------------------------- tool table
//
// pos: ["name"] = required, ["name", default] = optional, ["name", "+"]
//   = one-or-more, 3rd element = choices, 4th = value type.
// flags: name: "bool"|"str"|"int"|"float"|"append" or [type, {flag, choices,
//   default}]. Default flag spelling is the name with _ as -.
// (The op for each tool lives in buildArgs, the single mapping.)

const GROUPS = [
  ["Connection", ["ping", "debug", "status", "cancel"]],
  ["Exploring", ["list", "tree", "find", "grep", "count", "look"]],
  ["Scripts and Lua", ["read", "script", "lua", "exec"]],
  ["Organizing", ["delete", "move", "group", "duplicate", "rename", "selection", "waypoint", "undo", "redo", "attr", "tag"]],
  ["Moving", ["rotate", "face", "shift", "scale", "place", "pivot"]],
  ["Surfaces and physics", ["paint", "anchor", "collide", "terrain", "weld", "hitbox"]],
  ["Gameplay", ["light", "sound", "prompt", "particles", "sign", "beam", "trail", "explosion", "scatter"]],
  ["UI", ["ui_screen", "ui_frame", "ui_label", "ui_button", "ui_input", "ui_image", "ui_list"]],
  ["Marketplace", ["search", "info", "insert", "apply"]],
  ["Playtesting", ["play", "stop", "playstate", "logs", "screenshot", "click", "input", "look_through"]],
];

const TOOLS = {
  ping: { help: "health check - is Studio connected?" },
  debug: { help: "diagnostics: transport, versions, turn, drivers, errors" },
  status: { help: "is Studio live on this channel? reads the relay beacons (no Studio round-trip)", local: true },
  cancel: { help: "explains how to recover when a call looks stuck", local: true },
  exec: { help: 'send a raw op JSON: {"op":..., "args":...}', pos: [["json"]] },
  lua: { help: "run Lua inside Studio (code arg, or - for stdin)", pos: [["code", null]] },
  list: { help: "children of a path", pos: [["path", "game"]], flags: { recursive: "bool", max: "int" } },
  tree: { help: "recursive tree of a path", pos: [["path", "game"]], flags: { depth: "int" } },
  read: { help: "read an instance (script source by default, --json for full record)", pos: ["path"], flags: { json: "bool", props: "str" } },
  find: { help: "find instances by name or --tag", pos: [["query", ""]], flags: { cls: ["str", { flag: "--class" }], scope: ["str", { default: "game" }], max: "int", exact: "bool", tag: "str" } },
  grep: { help: "search script sources", pos: ["pattern"], flags: { scope: ["str", { default: "game" }], max: "int", i: ["bool", { flag: "-i" }] } },
  script: { help: "create/update a script (source from stdin or --source)", pos: ["parent", "name"], flags: { cls: ["str", { flag: "--class", default: "Script", choices: ["Script", "LocalScript", "ModuleScript"] }], mode: ["str", { choices: ["create", "update", "replace"], default: "create" }], source: "str" } },
  delete: { help: "delete instances", pos: [["paths", "+"]] },
  move: { help: "reparent an instance", pos: ["path", "parent"] },
  selection: { help: "read or set the Studio selection", pos: [], flags: { set: "str", clear: "bool" } },
  waypoint: { help: "name the undo step for what you are about to do", pos: [["label", "bridge"]] },
  rotate: { help: "rotate: --axis y --degrees 90 (relative) or --set 0,90,0 (absolute)", pos: ["path"], flags: { axis: "str", degrees: "float", absolute: ["str", { flag: "--set" }], space: ["str", { choices: ["world", "local"], default: "world" }] } },
  face: { help: "aim an instance's axis at a world point (keeps position)", pos: ["path", "target"], flags: { axis: ["str", { default: "forward" }] } },
  shift: { help: "move by an offset in studs (world or local)", pos: ["path", "offset"], flags: { space: ["str", { choices: ["world", "local"], default: "world" }] } },
  scale: { help: "scale a part/model by a relative factor", pos: ["path", ["factor", undefined, undefined, "float"]] },
  duplicate: { help: "clone an instance (optionally N times with spacing)", pos: ["path"], flags: { count: ["int", { default: 1 }], offset: "str", parent: "str", name: "str" } },
  group: { help: "wrap instances into a Model", pos: [["paths", "+"]], flags: { name: ["str", { default: "Group" }], parent: "str" } },
  pivot: { help: "set a model/part pivot (what it rotates around)", pos: ["path"], flags: { position: "str", orientation: "str" } },
  place: { help: "absolute position via pivot (parts and models)", pos: ["path", "position"], flags: { orientation: "str" } },
  paint: { help: "set color/material/transparency/reflectance on parts", pos: [["paths", "+"]], flags: { color: "str", material: "str", transparency: "float", reflectance: "float" } },
  rename: { help: "rename an instance", pos: ["path", "name"] },
  look: { help: "aim the Studio editor camera at a path", pos: ["path"], flags: { distance: ["float", { default: 30 }] } },
  count: { help: "count instances (cheap, no payloads)", pos: [["scope", "game"]], flags: { cls: ["str", { flag: "--class" }] } },
  undo: { help: "undo the last change (--times N)", pos: [], flags: { times: ["int", { default: 1 }] } },
  redo: { help: "redo an undone change (--times N)", pos: [], flags: { times: ["int", { default: 1 }] } },
  anchor: { help: "anchor parts in place (models: all their parts)", pos: [["paths", "+"]], flags: { off: "bool" } },
  collide: { help: "enable part collision (models: all their parts)", pos: [["paths", "+"]], flags: { off: "bool" } },
  light: { help: "add or update a light inside a part", pos: ["path"], flags: { light_type: ["str", { flag: "--type", default: "point", choices: ["point", "spot", "surface"] }], color: "str", range: "float", brightness: "float", shadows: "bool" } },
  sound: { help: "add a Sound to a parent, optionally play it", pos: ["parent", "id"], flags: { volume: "float", loop: "bool", play: "bool", name: "str" } },
  weld: { help: "weld a model's parts together with WeldConstraints", pos: [["paths", "+"]] },
  hitbox: { help: "wrap a model in an invisible collision box", pos: ["path"], flags: { padding: "float", name: "str" } },
  prompt: { help: "add a ProximityPrompt to a part (E to interact)", pos: ["path"], flags: { action: "str", object: "str", key: "str", distance: "float", hold: "float", text: "str" } },
  particles: { help: "add or update a ParticleEmitter", pos: ["path"], flags: { preset: "str", color: "str", rate: "float" } },
  sign: { help: "make a floating text sign (a part, or --position in the world)", pos: [["path", "Workspace"]], flags: { text: "str", position: "str", size: "float", name: "str" } },
  beam: { help: "beam between two parts", pos: ["from", "to"], flags: { color: "str", width: "float", curve: "float", name: "str" } },
  trail: { help: "add a Trail to a part", pos: ["path"], flags: { color: "str", lifetime: "float", name: "str" } },
  explosion: { help: "explode at a part or --position", pos: [["path", "Workspace"]], flags: { position: "str", radius: "float" } },
  scatter: { help: "clone a model/part N times in a radius", pos: ["path"], flags: { count: ["int", { default: 10 }], radius: "float", y_jitter: ["float", { flag: "--y-jitter" }], name: "str", parent: "str" } },
  ui_screen: { help: "create a ScreenGui under StarterGui", pos: ["name"], flags: { parent: "str", order: "int" } },
  ui_frame: { help: "rounded panel/frame", pos: ["parent", "name"], flags: { position: "str", size: "str", anchor: "str", color: "str", transparency: "float", radius: "int", clip: "bool" } },
  ui_label: { help: "text label", pos: ["parent", "name"], flags: { text: "str", position: "str", size: "str", anchor: "str", color: "str", align: "str", font: "str", text_size: "int", wrap: "bool" } },
  ui_button: { help: "text button", pos: ["parent", "name"], flags: { text: "str", position: "str", size: "str", anchor: "str", color: "str", text_color: "str", radius: "int", font: "str", text_size: "int" } },
  ui_input: { help: "TextBox the player can type into", pos: ["parent", "name"], flags: { placeholder: "str", text: "str", position: "str", size: "str", color: "str", background: "str", radius: "int", text_size: "int" } },
  ui_image: { help: "ImageLabel from a Roblox asset id", pos: ["parent", "name"], flags: { asset: "str", position: "str", size: "str", scale: "str" } },
  ui_list: { help: "UIListLayout that auto-arranges a container's children", pos: ["parent"], flags: { direction: "str", padding: "int", halign: "str", valign: "str" } },
  play: { help: "start a real play test - the game runs, you can see and control it", pos: [], flags: { mode: ["str", { choices: ["play", "run"], default: "play" }], resume: "bool" } },
  stop: { help: "stop the running play test" },
  playstate: { help: "is a test running, and are the in-game drivers alive?" },
  logs: { help: "read the play session's errors and warnings", pos: [], flags: { all: "bool", limit: "int", since: "float" } },
  screenshot: { help: "capture the viewport (or the running game) to a PNG", pos: [], flags: { label: "str", max_width: ["int", { flag: "--max-width", default: DEFAULT_SHOT_WIDTH }] } },
  click: { help: "click at viewport x,y inside the running game", pos: ["x", "y"], flags: { hold_ms: "int", button: ["str", { default: "left" }] } },
  input: { help: "send keys/text to the running game (e.g. w,space or --text hello)", pos: [["key", "+"]], flags: { text: "str", hold: "append", hold_seconds: "float", key_delay: "float" } },
  look_through: { help: "point the in-game camera at a path", pos: ["path"] },
  attr: { help: "read/set/clear Studio attributes on an instance", pos: ["path"], flags: { set: "append", clear: "append" } },
  tag: { help: "add/remove CollectionService tags", pos: [["paths", "+"]], flags: { add: "append", remove: "append" } },
  terrain: { help: "fill or clear terrain (block or ball)", pos: [], flags: { action: ["str", { choices: ["fill", "clear"], default: "fill" }], shape: ["str", { choices: ["block", "ball"], default: "block" }], position: "str", size: "str", radius: "float", material: ["str", { default: "Grass" }] } },
  search: { help: "search the Roblox Creator Store (models, meshes, images, audio, video, plugins)", pos: ["query"], flags: { category: ["str", { default: "model" }], limit: "int", cursor: "str" }, local: true },
  info: { help: "details + thumbnail for one marketplace asset", pos: ["id"], local: true },
  insert: { help: "insert a marketplace asset into the place", pos: ["id", ["parent", "Workspace"]], flags: { name: "str" } },
  apply: { help: "apply an asset id to a property (Image, Texture, SoundId, MeshId...)", pos: ["id", "path", "prop"] },
};

function stripTimeout(argv) {
  const outArgs = [];
  let timeout = null;
  let ddash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (ddash) { outArgs.push(a); continue; }
    if (a === "--") { ddash = true; outArgs.push(a); continue; }
    if (a === "--timeout" && i + 1 < argv.length) { timeout = parseFloat(argv[++i]); continue; }
    if (a.startsWith("--timeout=")) { timeout = parseFloat(a.slice(10)); continue; }
    outArgs.push(a);
  }
  if (timeout !== null && (!(timeout > 0) || !Number.isFinite(timeout)))
    throw new UsageError("--timeout must be a positive, finite number of seconds");
  return { args: outArgs, timeout };
}

function parseToolArgs(name, argv) {
  const spec = TOOLS[name];
  const ns = {};
  const bools = {}, vals = {};
  for (const dest of Object.keys(spec.flags || {})) {
    const fs = spec.flags[dest];
    const t = Array.isArray(fs) ? fs[0] : fs;
    const o = Array.isArray(fs) ? (fs[1] || {}) : {};
    const flag = o.flag || "--" + dest.replace(/_/g, "-");
    if (t === "bool") { ns[dest] = false; bools[flag] = dest; }
    else { ns[dest] = t === "append" ? [] : (o.default !== undefined ? o.default : null); vals[flag] = { dest, type: t, choices: o.choices, multi: t === "append" }; }
  }
  const coerce = (fl, raw) => {
    let v = raw;
    if (fl.type === "int") { v = parseInt(raw, 10); if (!Number.isInteger(v)) throw new UsageError(`${name}: bad integer for ${fl.dest}: ${raw}`); }
    else if (fl.type === "float") { v = parseFloat(raw); if (!Number.isFinite(v)) throw new UsageError(`${name}: bad number for ${fl.dest}: ${raw}`); }
    if (fl.choices && !fl.choices.includes(fl.type === "int" ? v : String(v))) throw new UsageError(`${name}: bad value for ${fl.dest}: ${raw} (need ${fl.choices.join("|")})`);
    return v;
  };
  const pos = [];
  let i = 0, ddash = false;
  while (i < argv.length) {
    const t = argv[i];
    if (ddash) { pos.push(t); i++; continue; }
    if (t === "--") { ddash = true; i++; continue; }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const fl = eq === -1 ? t : t.slice(0, eq);
      if (fl in bools) {
        if (eq !== -1) throw new UsageError(`${name}: ${fl} takes no value`);
        ns[bools[fl]] = true; i++; continue;
      }
      const v = vals[fl];
      if (!v) throw new UsageError(`${name}: unknown flag ${fl}`);
      let raw;
      if (eq !== -1) raw = t.slice(eq + 1);
      else { i++; if (i >= argv.length) throw new UsageError(`${name}: ${fl} needs a value`); raw = argv[i]; }
      const c = coerce(v, raw);
      if (v.multi) ns[v.dest].push(c); else ns[v.dest] = c;
      i++; continue;
    }
    if (t in bools) { ns[bools[t]] = true; i++; continue; }
    if (t.startsWith("-") && t.length > 1 && !/^-[-\d.]/.test(t)) {
      throw new UsageError(`${name}: unknown flag ${t}`);
    }
    pos.push(t); i++;
  }
  const outNs = {};
  let pi = 0;
  for (const p of (spec.pos || [])) {
    const a = Array.isArray(p) ? p : [p];
    const pname = a[0], pdef = a[1], pchoices = a[2], ptype = a[3];
    if (pdef === "+") {
      if (pi >= pos.length) throw new UsageError(`${name}: need at least one ${pname}`);
      outNs[pname] = pos.slice(pi); pi = pos.length;
    } else if (pi < pos.length) {
      const raw = pos[pi++];
      let v = raw;
      if (ptype === "int") { v = parseInt(raw, 10); if (!Number.isInteger(v)) throw new UsageError(`${name}: bad integer for ${pname}: ${raw}`); }
      else if (ptype === "float") { v = parseFloat(raw); if (!Number.isFinite(v)) throw new UsageError(`${name}: bad number for ${pname}: ${raw}`); }
      if (pchoices && !pchoices.includes(ptype ? v : String(v))) throw new UsageError(`${name}: bad ${pname}: ${raw} (need ${pchoices.join("|")})`);
      outNs[pname] = v;
    } else if (pdef !== undefined) outNs[pname] = pdef;
    else throw new UsageError(`${name}: missing ${pname}`);
  }
  if (pi < pos.length) throw new UsageError(`${name}: too many arguments (got "${pos[pi]}")`);
  const merged = Object.assign(ns, outNs);
  // Flags are declared snake_case (`--max-width` -> max_width) but buildArgs
  // reads some of them in camelCase. Expose both spellings so a declared flag
  // can never be silently ignored - that bug silently dropped five of them.
  for (const key of Object.keys(merged)) {
    if (!key.includes("_")) continue;
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!(camel in merged)) merged[camel] = merged[key];
  }
  return merged;
}

function vec3(s) {
  const parts = String(s)
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter((v) => v !== "")
    .map(Number);
  if (parts.length === 0 || parts.some((v) => !Number.isFinite(v))) {
    throw new UsageError(`bad vector "${s}" (expected x,y,z numbers)`);
  }
  if (parts.length === 1) return { x: parts[0], y: 0, z: 0 };
  if (parts.length !== 3) throw new UsageError(`bad vector "${s}" (expected x,y,z)`);
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function scalar(s) {
  const t = String(s).trim();
  if (/^[+-]?\d+$/.test(t)) { const n = parseInt(t, 10); if (Number.isSafeInteger(n)) return n; }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t)) { const f = parseFloat(t); if (Number.isFinite(f)) return f; }
  if (t === "true") return true;
  if (t === "false") return false;
  return s;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function buildArgs(name, ns) {
  const V = (s) => vec3(s);
  switch (name) {
    case "ping":
      return { op: "ping", args: {} };
    case "debug":
      return { op: "debug", args: {} };
    case "exec": {
      let raw;
      try { raw = JSON.parse(ns.json); } catch { throw new UsageError("exec: invalid JSON"); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.op !== "string" || !raw.op)
        throw new UsageError('exec: JSON must be an object with a string "op" key');
      return { op: raw.op, args: (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) ? raw.args : {} };
    }
    case "lua": {
      let code = ns.code;
      if (code === "-" || code == null) code = process.stdin.isTTY ? "" : readStdin();
      if (!code) throw new UsageError("no Lua code given (pass it as an argument or pipe it in)");
      return { op: "run", args: { code } };
    }
    case "list": {
      const a = { path: ns.path };
      if (ns.recursive) a.recursive = true;
      if (ns.max != null) {
        if (ns.max <= 0) throw new UsageError("list: --max must be a positive integer");
        a.max = ns.max;
      }
      return { op: "list", args: a };
    }
    case "tree": {
      const depth = ns.depth ?? 2;
      if (depth < 0) throw new UsageError("tree: --depth must be 0 or greater");
      return { op: "tree", args: { path: ns.path, depth } };
    }
    case "read": {
      const a = { path: ns.path };
      if (ns.props) a.props = ns.props.split(",").map((s) => s.trim()).filter(Boolean);
      return { op: "read", args: a, asJson: !!ns.json, rawField: "source" };
    }
    case "find": {
      const a = { scope: ns.scope };
      if (ns.tag) a.tag = ns.tag;
      else if (ns.query) a.query = ns.query;
      else throw new UsageError("find: need a name query or --tag");
      if (ns.cls) a.class = ns.cls;
      if (ns.max != null) {
        if (ns.max <= 0) throw new UsageError("find: --max must be a positive integer");
        a.max = ns.max;
      }
      if (ns.exact) a.exact = true;
      return { op: "find", args: a };
    }
    case "grep": {
      const a = { pattern: ns.pattern, scope: ns.scope };
      if (ns.max != null) {
        if (ns.max <= 0) throw new UsageError("grep: --max must be a positive integer");
        a.max = ns.max;
      }
      if (ns.i) a.caseSensitive = false;
      return { op: "grep", args: a };
    }
    case "script": {
      let source = ns.source;
      if (source == null && !process.stdin.isTTY) source = readStdin();
      if (source == null) throw new UsageError("pass the script source via stdin (heredoc/pipe) or --source");
      return { op: "script", args: { parent: ns.parent, name: ns.name, class: ns.cls, mode: ns.mode, source } };
    }
    case "delete":
      return { op: "delete", args: { paths: ns.paths } };
    case "move":
      return { op: "move", args: { path: ns.path, parent: ns.parent } };
    case "selection": {
      if (ns.clear) return { op: "selection", args: { clear: true } };
      if (ns.set != null) {
        const paths = ns.set.split(",").map((s) => s.trim()).filter(Boolean);
        if (!paths.length) throw new UsageError("selection: --set needs at least one path");
        return { op: "selection", args: { set: paths } };
      }
      return { op: "selection", args: {} };
    }
    case "waypoint":
      return { op: "waypoint", args: { label: ns.label } };
    case "rotate": {
      const a = { path: ns.path, space: ns.space };
      if (ns.absolute != null) a.orientation = V(ns.absolute);
      else {
        if (ns.axis == null || ns.degrees == null)
          throw new UsageError("rotate: need --set x,y,z or both --axis and --degrees");
        a.axis = ns.axis;
        a.degrees = ns.degrees;
      }
      return { op: "rotate", args: a };
    }
    case "face":
      return { op: "face", args: { path: ns.path, target: V(ns.target), axis: ns.axis } };
    case "shift":
      return { op: "shift", args: { path: ns.path, offset: V(ns.offset), space: ns.space } };
    case "scale":
      if (!(ns.factor > 0)) throw new UsageError("scale: factor must be a positive number");
      return { op: "scale", args: { path: ns.path, factor: ns.factor } };
    case "duplicate": {
      if (!(ns.count >= 1)) throw new UsageError("duplicate: --count must be 1 or greater");
      const a = { path: ns.path, count: ns.count };
      if (ns.offset) a.offset = V(ns.offset);
      if (ns.parent) a.parent = ns.parent;
      if (ns.name) a.name = ns.name;
      return { op: "duplicate", args: a };
    }
    case "group": {
      const a = { paths: ns.paths, name: ns.name };
      if (ns.parent) a.parent = ns.parent;
      return { op: "group", args: a };
    }
    case "pivot": {
      if (ns.position == null && ns.orientation == null)
        throw new UsageError("pivot: need --position and/or --orientation");
      const a = { path: ns.path };
      if (ns.position) a.position = V(ns.position);
      if (ns.orientation) a.orientation = V(ns.orientation);
      return { op: "set_pivot", args: a };
    }
    case "place": {
      const a = { path: ns.path, position: V(ns.position) };
      if (ns.orientation) a.orientation = V(ns.orientation);
      return { op: "place", args: a };
    }
    case "paint": {
      if (ns.color == null && ns.material == null && ns.transparency == null && ns.reflectance == null)
        throw new UsageError("paint: need at least one of --color, --material, --transparency, --reflectance");
      const a = { paths: ns.paths };
      if (ns.color) a.color = ns.color;
      if (ns.material) a.material = ns.material;
      if (ns.transparency != null) a.transparency = ns.transparency;
      if (ns.reflectance != null) a.reflectance = ns.reflectance;
      return { op: "paint", args: a };
    }
    case "rename":
      return { op: "rename", args: { path: ns.path, name: ns.name } };
    case "look":
      return { op: "look", args: { path: ns.path, distance: ns.distance } };
    case "count": {
      const a = { scope: ns.scope };
      if (ns.cls) a.class = ns.cls;
      return { op: "count", args: a };
    }
    case "undo":
    case "redo":
      return { op: name, args: { times: ns.times } };
    case "anchor":
      return { op: "anchor", args: { paths: ns.paths, anchored: !ns.off } };
    case "collide":
      return { op: "collide", args: { paths: ns.paths, canCollide: !ns.off } };
    case "light": {
      const a = { path: ns.path, type: ns.light_type };
      if (ns.color) a.color = ns.color;
      if (ns.range != null) a.range = ns.range;
      if (ns.brightness != null) a.brightness = ns.brightness;
      if (ns.shadows) a.shadows = true;
      return { op: "light", args: a };
    }
    case "sound": {
      const a = { parent: ns.parent, id: ns.id };
      if (ns.volume != null) a.volume = ns.volume;
      if (ns.loop) a.looped = true;
      if (ns.play) a.play = true;
      if (ns.name) a.name = ns.name;
      return { op: "sound", args: a };
    }
    case "weld":
      return { op: "weld", args: { paths: ns.paths } };
    case "hitbox": {
      const a = { path: ns.path };
      if (ns.padding != null) a.padding = ns.padding;
      if (ns.name) a.name = ns.name;
      return { op: "hitbox", args: a };
    }
    case "prompt": {
      const a = { path: ns.path };
      for (const k of ["action", "object", "key", "distance", "hold", "text"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "prompt", args: a };
    }
    case "particles": {
      const a = { path: ns.path };
      if (ns.preset) a.preset = ns.preset;
      if (ns.color) a.color = ns.color;
      if (ns.rate != null) a.rate = ns.rate;
      return { op: "particles", args: a };
    }
    case "sign": {
      const a = { path: ns.path };
      if (ns.text) a.text = ns.text;
      if (ns.position) a.position = V(ns.position);
      if (ns.size != null) a.size = ns.size;
      if (ns.name) a.name = ns.name;
      return { op: "sign", args: a };
    }
    case "beam": {
      const a = { from: ns.from, to: ns.to };
      if (ns.color) a.color = ns.color;
      if (ns.width != null) a.width = ns.width;
      if (ns.curve != null) a.curve = ns.curve;
      if (ns.name) a.name = ns.name;
      return { op: "beam", args: a };
    }
    case "trail": {
      const a = { path: ns.path };
      if (ns.color) a.color = ns.color;
      if (ns.lifetime != null) a.lifetime = ns.lifetime;
      if (ns.name) a.name = ns.name;
      return { op: "trail", args: a };
    }
    case "explosion": {
      const a = { path: ns.path };
      if (ns.position) a.position = V(ns.position);
      if (ns.radius != null) a.radius = ns.radius;
      return { op: "explosion", args: a };
    }
    case "scatter": {
      const a = { path: ns.path };
      if (ns.count != null) a.count = ns.count;
      if (ns.radius != null) a.radius = ns.radius;
      if (ns.yJitter != null) a.yJitter = ns.yJitter;
      if (ns.name) a.name = ns.name;
      if (ns.parent) a.parent = ns.parent;
      return { op: "scatter", args: a };
    }
    case "ui_screen": {
      const a = { name: ns.name };
      if (ns.parent) a.parent = ns.parent;
      if (ns.order != null) a.order = ns.order;
      return { op: "ui_screen", args: a };
    }
    case "ui_frame": {
      const a = { parent: ns.parent, name: ns.name };
      for (const k of ["position", "size", "anchor", "color", "transparency", "radius"]) if (ns[k] != null) a[k] = ns[k];
      if (ns.clip) a.clip = true;
      return { op: "ui_frame", args: a };
    }
    case "ui_label": {
      const a = { parent: ns.parent, name: ns.name };
      for (const k of ["text", "position", "size", "anchor", "color", "align", "font", "text_size"]) if (ns[k] != null) a[k] = ns[k];
      if (ns.wrap) a.wrap = true;
      return { op: "ui_label", args: a };
    }
    case "ui_button": {
      const a = { parent: ns.parent, name: ns.name };
      for (const k of ["text", "position", "size", "anchor", "color", "text_color", "radius", "font", "text_size"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "ui_button", args: a };
    }
    case "ui_input": {
      const a = { parent: ns.parent, name: ns.name };
      for (const k of ["placeholder", "text", "position", "size", "color", "background", "radius", "text_size"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "ui_input", args: a };
    }
    case "ui_image": {
      const a = { parent: ns.parent, name: ns.name };
      if (ns.asset) a.asset = ns.asset;
      for (const k of ["position", "size", "scale"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "ui_image", args: a };
    }
    case "ui_list": {
      const a = { parent: ns.parent };
      for (const k of ["direction", "padding", "halign", "valign"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "ui_list", args: a };
    }
    case "play": {
      const a = { mode: ns.mode };
      if (ns.resume) a.resume = true;
      return { op: "play", args: a };
    }
    case "stop":
      return { op: "stop", args: {} };
    case "playstate":
      return { op: "playstate", args: {} };
    case "logs": {
      const a = ns.all ? { filter: "all" } : {};
      if (ns.limit != null) {
        if (ns.limit <= 0) throw new UsageError("logs: --limit must be a positive integer");
        a.limit = ns.limit;
      }
      if (ns.since != null) a.since = ns.since;
      return { op: "logs", args: a };
    }
    case "screenshot": {
      const a = {};
      if (ns.label) a.label = ns.label;
      if (ns.maxWidth != null) {
        if (ns.maxWidth < 64) throw new UsageError("screenshot: --max-width must be at least 64");
        if (ns.maxWidth > DEFAULT_SHOT_WIDTH) {
          throw new UsageError(
            `screenshot: --max-width ${ns.maxWidth} would not fit through the relay; ` +
              `the largest capture that arrives intact is ${DEFAULT_SHOT_WIDTH}. ` +
              `Use look_through to get closer instead.`
          );
        }
        a.maxWidth = ns.maxWidth;
      }
      return { op: "screenshot", args: a, screenshot: true, label: ns.label };
    }
    case "click": {
      const x = parseFloat(ns.x), y = parseFloat(ns.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new UsageError("click: x and y must be numbers (viewport pixels)");
      const a = { x, y };
      if (ns.holdMs != null) a.holdMs = ns.holdMs;
      if (ns.button) a.button = ns.button;
      return { op: "click", args: a };
    }
    case "input": {
      const a = {};
      const keys = ns.key || [];
      if (keys.length) a.keys = keys;
      if (ns.text) a.text = ns.text;
      if (ns.hold && ns.hold.length) a.hold = ns.hold;
      if (ns.holdSeconds != null) a.holdSeconds = ns.holdSeconds;
      if (ns.keyDelay != null) a.keyDelay = ns.keyDelay;
      if (!a.keys && !a.text && !a.hold) throw new UsageError("input: give keys (w,a,space), --text, or --hold");
      return { op: "input", args: a };
    }
    case "look_through":
      return { op: "look_through", args: { path: ns.path } };
    case "attr": {
      const a = { path: ns.path };
      if (ns.set && ns.set.length) {
        const sets = {};
        for (const kv of ns.set) {
          const e = kv.indexOf("=");
          if (e === -1) throw new UsageError("--set expects K=V");
          const key = kv.slice(0, e);
          if (!key) throw new UsageError("--set expects K=V with a non-empty key");
          sets[key] = scalar(kv.slice(e + 1));
        }
        a.set = sets;
      }
      if (ns.clear && ns.clear.length) a.clear = ns.clear;
      return { op: "attributes", args: a };
    }
    case "tag": {
      const a = { paths: ns.paths };
      if ((!ns.add || !ns.add.length) && (!ns.remove || !ns.remove.length))
        throw new UsageError("tag: need --add and/or --remove");
      for (const t of [...(ns.add || []), ...(ns.remove || [])]) {
        if (!t) throw new UsageError("tag: tag names must not be empty");
      }
      if (ns.add && ns.add.length) a.add = ns.add;
      if (ns.remove && ns.remove.length) a.remove = ns.remove;
      return { op: "tag", args: a };
    }
    case "terrain": {
      if (!ns.position) throw new UsageError("terrain: --position x,y,z is required");
      const a = { action: ns.action, shape: ns.shape, position: V(ns.position), material: ns.material };
      if (ns.shape === "block") {
        if (!ns.size) throw new UsageError("--size x,y,z is required for block");
        a.size = V(ns.size);
      } else {
        if (ns.radius == null) throw new UsageError("--radius is required for ball");
        a.radius = ns.radius;
      }
      return { op: "terrain", args: a };
    }
    case "insert": {
      const a = { id: ns.id, parent: ns.parent };
      if (ns.name) a.name = ns.name;
      return { op: "insert_asset", args: a };
    }
    case "apply":
      return { op: "apply_asset", args: { id: ns.id, path: ns.path, prop: ns.prop } };
    default:
      throw new UsageError(`unknown tool: ${name}`);
  }
}

function toolUsage(name) {
  const spec = TOOLS[name];
  const parts = [`npx golem-bridge ${name}`];
  for (const p of (spec.pos || [])) {
    const a = Array.isArray(p) ? p : [p];
    if (a[1] === "+") parts.push(`<${a[0]}...>`);
    else if (a[1] !== undefined) parts.push(`[${a[0]}]`);
    else parts.push(`<${a[0]}>`);
  }
  if (spec.flags && Object.keys(spec.flags).length) parts.push("[options]");
  return parts.join(" ");
}

function printHelp() {
  console.log("golem-bridge: drive a live Roblox Studio session from any AI agent.");
  console.log("");
  console.log("Studio and this CLI meet at a relay, because a cloud agent cannot reach");
  console.log("your machine and a Studio plugin can only make outgoing calls.");
  console.log("");
  console.log("  Start:  paste the setup line from the Golem window in Studio:");
  console.log("          npx golem-bridge connect <channelId>");
  console.log("");
  console.log("Session: connect <line> | reconnect [line] | disconnect | status | cancel | manual | help [tool]");
  for (const [group, names] of GROUPS) {
    console.log("");
    console.log(`${group}:`);
    for (const n of names) console.log(`  ${n} - ${TOOLS[n].help}`);
  }
  console.log("");
  console.log("See one tool: npx golem-bridge help <tool>. Full reference: npx golem-bridge manual.");
}

function toolHelp(name) {
  const spec = TOOLS[name];
  if (!spec) {
    console.error(`golem-bridge: unknown tool "${name}"`);
    process.exitCode = 2;
    return;
  }
  console.log(`${name} - ${spec.help}`);
  console.log("");
  console.log(`Usage: ${toolUsage(name)}`);
  const flags = spec.flags || {};
  const names = Object.keys(flags);
  if (names.length) {
    console.log("");
    console.log("Options:");
    for (const d of names) {
      const fs2 = flags[d];
      const t = Array.isArray(fs2) ? fs2[0] : fs2;
      const o = Array.isArray(fs2) ? (fs2[1] || {}) : {};
      let line = `  ${o.flag || "--" + d.replace(/_/g, "-")}`;
      if (t !== "bool") line += ` <${t === "append" ? "value (repeatable)" : "value"}>`;
      if (o.choices) line += ` (${o.choices.join("|")})`;
      if (o.default !== undefined) line += ` [default: ${o.default}]`;
      console.log(line);
    }
  }
  console.log("");
  console.log("Add --timeout <seconds> to wait longer for a slow call.");
}

const MANUAL_FILE = path.join(__dirname, "golem-tools.md");

function printManual() {
  try {
    process.stdout.write(fs.readFileSync(MANUAL_FILE, "utf8").trimEnd() + "\n");
  } catch {
    fail("manual not found next to cli.js - reinstall the package.", 1);
  }
}

// -------------------------------------------------------------- screenshots
// The plugin sends raw RGBA as "x,y,r,g,b,a;..." pairs. Writing the PNG here
// keeps the plugin small and means the AI gets a file it can actually open.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodeRgbaCsv(text, width, height) {
  const buf = Buffer.alloc(width * height * 4);
  let i = 0;
  for (const pixel of String(text || "").split(";")) {
    if (i >= buf.length) break;
    const parts = pixel.split(",");
    if (parts.length < 4) {
      i += 4;
      continue;
    }
    buf[i++] = Math.max(0, Math.min(255, parseInt(parts[0], 10) || 0));
    buf[i++] = Math.max(0, Math.min(255, parseInt(parts[1], 10) || 0));
    buf[i++] = Math.max(0, Math.min(255, parseInt(parts[2], 10) || 0));
    buf[i++] = Math.max(0, Math.min(255, parseInt(parts[3], 10) || 255));
  }
  return buf;
}

function writeScreenshot(result, label) {
  const width = parseInt(result.width, 10);
  const height = parseInt(result.height, 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("the capture came back without a usable size");
  }
  const safe = String(label || result.label || "viewport").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "viewport";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(shotsDir(), `${safe}-${stamp}.png`);
  fs.mkdirSync(shotsDir(), { recursive: true });
  fs.writeFileSync(file, encodePng(width, height, decodeRgbaCsv(result.pixels, width, height)));
  return { file, width, height };
}

// ---------------------------------------------------------------- marketplace
// search/info run on this machine: Studio's HttpService cannot reach roblox.com.

const MP_CATEGORIES = {
  model: "Model", models: "Model", mesh: "MeshPart", meshes: "MeshPart", meshpart: "MeshPart",
  decal: "Decal", decals: "Decal", image: "Decal", images: "Decal", picture: "Decal", texture: "Decal",
  audio: "Audio", sound: "Audio", sounds: "Audio", music: "Audio",
  video: "Video", videos: "Video", plugin: "Plugin", plugins: "Plugin",
};
const ASSET_TYPE_NAMES = { 1: "Image", 3: "Audio", 4: "Mesh", 9: "Decal", 10: "Model", 18: "Video", 19: "Font", 40: "MeshPart" };

async function webJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": `golem-bridge/${VERSION}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from Roblox: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error("request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function mpSearch(query, category, limit, cursor) {
  const assetType = MP_CATEGORIES[String(category || "model").toLowerCase()];
  if (!assetType) throw new Error(`unknown category '${category}' (valid: model, mesh, image, audio, video, plugin)`);
  let n = parseInt(limit, 10);
  if (!Number.isFinite(n)) n = 10;
  n = Math.max(1, Math.min(n, 50));
  let url = `https://apis.roblox.com/toolbox-service/v1/marketplace/${assetType}?keyword=${encodeURIComponent(String(query))}&limit=${n}`;
  if (cursor) url += `&cursor=${encodeURIComponent(String(cursor))}`;
  const data = await webJson(url);
  const ids = ((data && data.data) || []).filter((it) => it && it.id != null).map((it) => it.id);
  const details = {};
  const thumbs = {};
  const enriched = Math.min(ids.length, 12);
  for (let i = 0; i < enriched; i++) {
    try {
      details[ids[i]] = await webJson(`https://economy.roblox.com/v2/assets/${ids[i]}/details`);
    } catch {
      // one bad asset must not kill the search
    }
    if (i < enriched - 1) await sleep(400); // the economy API rate limits hard
  }
  if (ids.length) {
    try {
      const tdata = await webJson(
        `https://thumbnails.roblox.com/v1/assets?assetIds=${ids.slice(0, 12).join(",")}&size=420x420&format=Png`
      );
      for (const th of (tdata && tdata.data) || []) {
        if (th && th.targetId != null) thumbs[th.targetId] = th;
      }
    } catch {
      // thumbnails are a bonus
    }
  }
  const results = ids.map((aid) => {
    const d = details[aid];
    const th = thumbs[aid];
    const entry = { id: aid, category: assetType };
    if (d && typeof d === "object") {
      entry.name = d.Name;
      entry.assetTypeId = d.AssetTypeId;
      entry.assetType = ASSET_TYPE_NAMES[d.AssetTypeId];
      if (d.Creator && typeof d.Creator === "object") entry.creator = d.Creator.Name;
      entry.priceInRobux = d.PriceInRobux ?? null;
      if (d.IsForSale != null) entry.forSale = d.IsForSale;
      if (typeof d.Description === "string" && d.Description) entry.description = d.Description.slice(0, 280);
    } else {
      entry.detailsUnavailable = true;
    }
    if (th && typeof th === "object") {
      entry.thumbnail = th.imageUrl;
      entry.thumbnailState = th.state;
    }
    return entry;
  });
  const output = { totalResults: (data && data.totalResults) ?? 0, results };
  if (data && data.nextPageCursor) output.nextPageCursor = data.nextPageCursor;
  return output;
}

async function mpInfo(assetId) {
  const text = String(assetId == null ? "" : assetId).trim();
  if (!/^\d+$/.test(text)) throw new Error(`bad asset id '${assetId}'`);
  const aid = parseInt(text, 10);
  const d = await webJson(`https://economy.roblox.com/v2/assets/${aid}/details`);
  const output = { id: aid };
  if (d && typeof d === "object") {
    output.name = d.Name;
    output.assetTypeId = d.AssetTypeId;
    output.assetType = ASSET_TYPE_NAMES[d.AssetTypeId];
    if (d.Creator && typeof d.Creator === "object") output.creator = d.Creator.Name;
    output.priceInRobux = d.PriceInRobux ?? null;
    if (d.IsForSale != null) output.forSale = d.IsForSale;
    if (typeof d.Description === "string") output.description = d.Description.slice(0, 1000);
  }
  try {
    const tdata = await webJson(`https://thumbnails.roblox.com/v1/assets?assetIds=${aid}&size=420x420&format=Png`);
    if (Array.isArray(tdata && tdata.data) && tdata.data.length) {
      output.thumbnail = tdata.data[0].imageUrl;
      output.thumbnailState = tdata.data[0].state;
    }
  } catch {
    // thumbnails are a bonus
  }
  return output;
}


// ------------------------------------------------------------- connection ops
/** One command, end to end, through the relay. */
async function runCommand(link, op, args, timeoutSec) {
  const turn = currentTurn();
  // The turn token rides along on every command of a request so the plugin can
  // open the turn on the first call instead of the next one.
  const envelope = await relayCall(link.channel, op, Object.assign({}, args, { __turn: turn.token }), timeoutSec);
  return envelope;
}

// Slow ops need longer minimum waits, but only when the user did not pass an
// explicit --timeout: an explicit timeout is always respected.
const TIMEOUT_MIN = { ping: 60, debug: 90, insert_asset: 300, play: 180, stop: 90, screenshot: 90 };

function waitFor(op, timeout) {
  if (timeout != null) return timeout;
  return Math.max(DEFAULT_TIMEOUT, TIMEOUT_MIN[op] || 0);
}

async function connect(setupLine, opts) {
  const o = opts || {};
  const parsed = parseSetupLine(setupLine);
  if (!parsed) {
    fail(
      "connect: expected the setup line from the Golem window (npx golem-bridge connect <channelId>). Copy the whole line.",
      2
    );
  }
  const channel = parsed.channel;
  console.log(`relay: ${relayBase()}`);
  process.stderr.write("asking Studio to answer");
  const entry = await relayCall(channel, "ping", {}, o.timeout || 60);
  process.stderr.write("\n");
  if (!entry || !entry.ok) {
    saveLink({ channel });
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            (entry && entry.error) ||
            "Studio did not answer that channel. Copy the line from the Golem window in Studio; it changes every Studio session.",
          savedTo: linkFile(),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }
  const res = (entry.result && typeof entry.result === "object" && entry.result) || {};
  const place = res.place || res.placeName || entry.place;
  const saved = saveLink({ channel, place, pluginVersion: res.version });
  console.log(`connected. place: ${place || "(unknown)"}${res.version ? `  (plugin v${res.version})` : ""}`);
  console.log(`saved to ${saved}`);
  const shadow = envOf("GOLEM_CHANNEL", "AIB_CHANNEL");
  if (shadow) console.error(`warning: $GOLEM_CHANNEL is set - it overrides the saved channel.`);
  console.log("");
  printManual();
}

function disconnect() {
  const dir = golemDir();
  let removed = false;
  for (const name of ["link.json", "turn.json", ...STALE_FILES]) {
    const f = path.join(dir, name);
    try {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed = true; }
    } catch {
      // keep going
    }
  }
  try { fs.rmdirSync(dir); } catch {
    // stays if not empty (shots, etc.)
  }
  console.log(removed ? "disconnected (local link files removed)." : "already disconnected (nothing saved).");
}

function cancelQueued() {
  console.log("nothing to cancel: with the relay, each tool call waits on its own reply.");
  console.log("If a call looks stuck, press Ctrl+C here and ask Studio to restart - a stuck");
  console.log("command cannot hold the channel open, it only expires.");
}

function parseToolInvocation(name, argv) {
  const { args, timeout } = stripTimeout(argv);
  return { ns: parseToolArgs(name, args), timeout };
}

async function runRelayTool(name, argv) {
  let ns, timeout, built;
  try {
    ({ ns, timeout } = parseToolInvocation(name, argv));
    built = buildArgs(name, ns);
  } catch (err) {
    if (err instanceof UsageError) { console.error(`golem-bridge: ${err.message}`); process.exitCode = 2; return; }
    throw err;
  }
  const link = requireLink();
  if (!link) return;
  const op = built.op;
  const entry = await runCommand(link, op, built.args, waitFor(op, timeout));

  // A screenshot arrives as raw pixels: turn it into a PNG the AI can open.
  if (built.screenshot && entry && entry.ok && entry.result && entry.result.format === "rgba-csv") {
    try {
      const shot = writeScreenshot(entry.result, built.label);
      entry.result = {
        file: shot.file,
        width: shot.width,
        height: shot.height,
        source: entry.result.source,
        note: "open this PNG to see what the game looks like right now",
      };
    } catch (err) {
      entry = { id: entry.id, op, ok: false, error: `could not write the screenshot: ${err.message}` };
    }
  }
  const rawField = built.rawField || (op === "read" || op === "script" ? "source" : null);
  out(entry, { asJson: built.asJson, rawField });
}

async function runLocalTool(name, argv) {
  let ns;
  try {
    ({ ns } = parseToolInvocation(name, argv));
  } catch (err) {
    if (err instanceof UsageError) { console.error(`golem-bridge: ${err.message}`); process.exitCode = 2; return; }
    throw err;
  }
  if (name === "status") { out(await status()); return; }
  if (name === "cancel") { await cancelQueued(); return; }
  if (name === "search" || name === "info") {
    try {
      const result = name === "search"
        ? await mpSearch(ns.query, ns.category, ns.limit, ns.cursor)
        : await mpInfo(ns.id);
      out({ ok: true, op: name, result });
    } catch (err) {
      out({ ok: false, op: name, error: name === "search" ? `marketplace search failed: ${err.message}` : `asset info failed: ${err.message}` });
    }
  }
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") { printHelp(); return; }
  if (args[0] === "--version" || args[0] === "-v") { console.log(VERSION); return; }
  const cmd = args[0];
  const rest = args.slice(1);
  if (cmd === "help") {
    if (!rest.length) { printHelp(); return; }
    toolHelp(rest[0]);
    return;
  }
  if (cmd === "manual") { printManual(); return; }
  if (cmd === "connect" || cmd === "reconnect") {
    let timeout = null;
    let line = null;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--timeout" && k + 1 < rest.length) timeout = parseFloat(rest[++k]);
      else if (a.startsWith("--timeout=")) timeout = parseFloat(a.slice(10));
      else if (!a.startsWith("-") && line === null) line = a;
      else { console.error(`golem-bridge: ${cmd}: bad argument ${a}`); process.exitCode = 2; return; }
    }
    if (timeout != null && (!(timeout > 0) || !Number.isFinite(timeout))) {
      console.error("golem-bridge: --timeout must be a positive, finite number of seconds");
      process.exitCode = 2;
      return;
    }
    // reconnect with no argument re-tries the channel already saved, which is
    // what you want after Studio restarts mid-conversation
    if (line === null) {
      if (cmd !== "reconnect") fail("connect: need the setup line from the Golem window.", 2);
      const saved = loadLink();
      if (!saved) fail("reconnect: nothing saved yet - run: npx golem-bridge connect <channelId>", 2);
      line = saved.channel;
      console.log(`re-trying the saved channel ${line}`);
    }
    await connect(line, { timeout });
    return;
  }
  if (cmd === "disconnect") { disconnect(); return; }
  if (Object.hasOwn(TOOLS, cmd)) {
    if (TOOLS[cmd].local) await runLocalTool(cmd, rest);
    else await runRelayTool(cmd, rest);
    return;
  }
  console.error(`golem-bridge: unknown command "${cmd}" (try: help)`);
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => { console.error(`golem-bridge error: ${(err && err.message) || err}`); process.exitCode = 1; });
}

module.exports = {
  TOOLS,
  GROUPS,
  parseToolArgs,
  buildArgs,
  vec3,
  scalar,
  stripTimeout,
  parseSetupLine,
  loadLink,
  saveLink,
  golemDir,
  currentTurn,
  encodePng,
  decodeRgbaCsv,
  writeScreenshot,
  mpSearch,
  mpInfo,
  status,
  relayCall,
  relayBase,
  isValidChannel,
  pollIntervalMs,
  isTooLarge,
  UsageError,
  main,
};


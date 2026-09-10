#!/usr/bin/env node
"use strict";

// golem-bridge: drive a live Roblox Studio session from any AI agent.
// Session setup (connect/reconnect/disconnect) plus every Studio tool,
// all through the Firebase command relay. Zero dependencies.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// GOLEM_* names are preferred; AIB_* are the legacy aliases kept for
// backward compatibility with existing setups and scripts.
function envOf(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

const DB_URL = envOf("GOLEM_FIREBASE_DB", "AIB_FIREBASE_DB") || "https://roblox-golem-default-rtdb.firebaseio.com";
const POLL_INTERVAL_MS = Math.max(250, (parseFloat(envOf("GOLEM_POLL_INTERVAL", "AIB_POLL_INTERVAL")) || 2) * 1000);
const FETCH_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 120;
// Channel IDs are hex tokens minted by the Studio plugin (16 chars today,
// tolerated 8-64 for forward compatibility). Anything else is rejected so a
// malformed ID can never alter the request URL.
const CHANNEL_RE = /^[0-9a-fA-F]{8,64}$/;

let VERSION = "unknown";
try {
  VERSION = require("./package.json").version || "unknown";
} catch {
  // running outside the package dir; version is informational only
}

// The relay must be HTTPS (plain HTTP is only allowed for localhost, for
// local Firebase emulator testing). Trailing slashes are stripped so URL
// joins stay clean. Takes an optional override for testability.
function relayBase(url) {
  const raw = String(url !== undefined ? url : DB_URL || "").replace(/\/+$/, "");
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

function fail(message, exitCode) {
  console.error(`golem-bridge error: ${message}`);
  process.exit(exitCode || 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function relayCall(channelId, op, args, timeoutSec) {
  let base;
  try {
    base = relayBase();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const enc = encodeURIComponent(channelId);
  const cmdId = `c${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;
  const payload = JSON.stringify({ id: cmdId, op, args: args || {}, ts: Math.floor(Date.now() / 1000) });
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
        sinceKey = key;
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
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    error: `timed out after ${timeoutSec}s waiting for Studio to answer '${op}'. Is Roblox Studio open with the Golem plugin connected to the relay?`,
  };
}

function turnReminder(entry) {
  if (!entry || !entry.turnOpen) return;
  const n = entry.turnTools;
  const head =
    typeof n === "number"
      ? `>> TURN STILL OPEN (${n} tools) - do NOT reply yet.`
      : ">> TURN STILL OPEN - do NOT reply yet.";
  console.error(`${head} When this task is done, close it with:\n>>    npx golem-bridge turn end --note "your reply"`);
}

// Exit codes: 0 = ok, 1 = Studio/relay reported an error, 2 = usage error.
// Usage errors never go through out(); they print directly and exit 2.
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

class UsageError extends Error {}

function loadChannel() {
  const fromEnv = envOf("GOLEM_CHANNEL", "AIB_CHANNEL");
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".golem", "channel"), "utf8").trim();
    if (raw) return raw;
  } catch {
    // fall through to the 2.x stamped helper below
  }
  for (const name of ["golem-helper.py", "golem.py"]) {
    try {
      const src = fs.readFileSync(path.join(process.cwd(), ".golem", name), "utf8");
      const m = src.match(/CHANNEL = os\.environ\.get\("AIB_CHANNEL", "([0-9a-fA-F]+)"\)/);
      if (m) return m[1];
    } catch {
      // try the next name
    }
  }
  return null;
}

function isValidChannel(id) {
  return typeof id === "string" && CHANNEL_RE.test(id);
}

function requireChannel() {
  const id = loadChannel();
  if (!isValidChannel(id)) {
    out({ ok: false, error: "not connected (no channel saved) - run: npx golem-bridge connect <channelId>" });
    return null;
  }
  return id;
}

// Leftover filenames from the 2.x Python helper, cleaned up on connect.
const STALE_HELPER_FILES = ["golem-helper.py", "golem-tools.md", "golem.py", "golem.md"];

function removeStaleHelpers(dir) {
  for (const stale of STALE_HELPER_FILES) {
    try {
      fs.rmSync(path.join(dir, stale), { force: true });
    } catch {
      // cleanup must never block a connect
    }
  }
}

// The channel id is a capability secret, so the file must not be
// world-readable. Returns the path of the written file.
function saveChannel(dir, id) {
  try {
    removeStaleHelpers(dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "channel");
    fs.writeFileSync(file, id + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600); // tighten pre-existing files too (mode only applies on creation)
    } catch {
      // best effort (e.g. filesystems without unix permissions)
    }
  } catch (err) {
    fail(`cannot save the channel file in ${dir}: ${err.message}`, 1);
  }
  return path.join(dir, "channel");
}

function envChannelName() {
  if (process.env.GOLEM_CHANNEL) return "GOLEM_CHANNEL";
  if (process.env.AIB_CHANNEL) return "AIB_CHANNEL";
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- marketplace
// search/info always run on this machine: Studio's HttpService cannot reach
// roblox.com, so there is no plugin-side marketplace path.

const MP_CATEGORIES = {
  model: "Model", models: "Model", mesh: "MeshPart", meshes: "MeshPart", meshpart: "MeshPart",
  decal: "Decal", decals: "Decal", image: "Decal", images: "Decal", picture: "Decal", texture: "Decal",
  audio: "Audio", sound: "Audio", sounds: "Audio", music: "Audio",
  video: "Video", videos: "Video", plugin: "Plugin", plugins: "Plugin",
};
const ASSET_TYPE_NAMES = { 1: "Image", 3: "Audio", 4: "Mesh", 9: "Decal", 10: "Model", 18: "Video", 19: "Font", 40: "MeshPart" };

async function mpGet(url) {
  const r = await fetchText(url, { headers: { "User-Agent": `golem-bridge/${VERSION}` }, timeoutMs: 20000 });
  if (!r.ok) throw new Error(`HTTP ${r.status} from Roblox: ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text);
}

async function mpSearch(query, category, limit, cursor) {
  const assetType = MP_CATEGORIES[String(category || "model").toLowerCase()];
  if (!assetType) throw new Error(`unknown category '${category}' (valid: model, mesh, image, audio, video, plugin)`);
  let n = parseInt(limit, 10);
  if (!Number.isFinite(n)) n = 10;
  n = Math.max(1, Math.min(n, 50));
  let url = `https://apis.roblox.com/toolbox-service/v1/marketplace/${assetType}?keyword=${encodeURIComponent(String(query))}&limit=${n}`;
  if (cursor) url += `&cursor=${encodeURIComponent(String(cursor))}`;
  const data = await mpGet(url);
  const ids = ((data && data.data) || []).filter((it) => it && it.id != null).map((it) => it.id);
  const details = {};
  const thumbs = {};
  const enriched = Math.min(ids.length, 12);
  for (let i = 0; i < enriched; i++) {
    try {
      details[ids[i]] = await mpGet(`https://economy.roblox.com/v2/assets/${ids[i]}/details`);
    } catch {
      // one bad asset must not kill the search
    }
    if (i < enriched - 1) await sleep(400); // the economy API rate limits hard
  }
  if (ids.length) {
    try {
      const tdata = await mpGet(
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
      entry.priceInRobux = d.PriceInRobux ?? null; // null = free or unknown
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
  const d = await mpGet(`https://economy.roblox.com/v2/assets/${aid}/details`);
  const output = { id: aid };
  if (d && typeof d === "object") {
    output.name = d.Name;
    output.assetTypeId = d.AssetTypeId;
    output.assetType = ASSET_TYPE_NAMES[d.AssetTypeId];
    if (d.Creator && typeof d.Creator === "object") output.creator = d.Creator.Name;
    output.priceInRobux = d.PriceInRobux ?? null; // null = free or unknown
    if (d.IsForSale != null) output.forSale = d.IsForSale;
    if (typeof d.Description === "string") output.description = d.Description.slice(0, 1000);
  }
  try {
    const tdata = await mpGet(`https://thumbnails.roblox.com/v1/assets?assetIds=${aid}&size=420x420&format=Png`);
    if (Array.isArray(tdata && tdata.data) && tdata.data.length) {
      output.thumbnail = tdata.data[0].imageUrl;
      output.thumbnailState = tdata.data[0].state;
    }
  } catch {
    // thumbnails are a bonus
  }
  return output;
}

async function status() {
  const channel = loadChannel();
  if (!isValidChannel(channel)) {
    return { ok: false, error: "not connected (no channel saved) - run: npx golem-bridge connect <channelId>" };
  }
  let beaconData;
  let resKeys;
  try {
    const base = relayBase();
    const enc = encodeURIComponent(channel);
    const bb = await fetchText(`${base}/channels/${enc}/beacons.json?orderBy=${encodeURIComponent('"$key"')}&limitToLast=5`, {
      timeoutMs: 30000,
    });
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
      ? `no beacons, but ${results} cached result(s) - Studio is not running or runs an older plugin; ask the user to fully restart Studio with the current plugin`
      : "result channel is empty - the plugin has never posted here: Studio is closed or was not restarted after a plugin update";
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
// (The relay op for each tool lives in buildArgs, the single mapping.)

const GROUPS = [
  ["Connection", ["ping", "debug", "status"]],
  ["Exploring", ["list", "tree", "find", "grep", "count", "look"]],
  ["Scripts and Lua", ["read", "script", "lua", "exec"]],
  ["Organizing", ["delete", "move", "group", "duplicate", "rename", "selection", "waypoint", "undo", "attr", "tag"]],
  ["Moving", ["rotate", "face", "shift", "scale", "place", "pivot"]],
  ["Surfaces and physics", ["paint", "anchor", "collide", "terrain"]],
  ["Gameplay", ["light", "sound", "prompt", "hitbox", "particles", "sign", "scatter", "match", "weld"]],
  ["Effects", ["beam", "trail", "explosion"]],
  ["UI", ["ui_screen", "ui_frame", "ui_label", "ui_button", "ui_input", "ui_image", "ui_list"]],
  ["Marketplace", ["search", "info", "insert", "apply"]],
  ["Playtesting", ["play", "stop", "logs"]],
  ["Session", ["say", "turn"]],
];

const TOOLS = {
  ping: { help: "health check - is Studio connected?" },
  debug: { help: "diagnostics: relay round-trip, versions, commands served, errors" },
  status: { help: "is the plugin alive or the link revoked? (no Studio needed)", local: true },
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
  waypoint: { help: "set an undo checkpoint", pos: [["label", "bridge"]] },
  say: { help: "post a message to the user's Studio chat (closes the turn)", pos: ["text"] },
  turn: { help: "mark work turns: begin ... tools ... end --note (required protocol)", pos: [["action", undefined, ["begin", "end"]]], flags: { note: "str" } },
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
  undo: { help: "one Studio undo step (Ctrl+Z)" },
  anchor: { help: "anchor parts in place (models: all their parts)", pos: [["paths", "+"]], flags: { off: "bool" } },
  collide: { help: "enable part collision (models: all their parts)", pos: [["paths", "+"]], flags: { off: "bool" } },
  light: { help: "add or update a light inside a part", pos: ["path"], flags: { light_type: ["str", { flag: "--type", default: "point", choices: ["point", "spot", "surface"] }], color: "str", range: "float", brightness: "float", shadows: "bool" } },
  sound: { help: "add a Sound to a parent, optionally play it", pos: ["parent", "id"], flags: { volume: "float", loop: "bool", play: "bool", name: "str" } },
  weld: { help: "weld a model's parts together with WeldConstraints", pos: [["paths", "+"]] },
  hitbox: { help: "invisible hitbox part sized to a target", pos: ["path"], flags: { padding: ["float", { default: 0.5 }], name: "str", collide: "bool" } },
  prompt: { help: "add a ProximityPrompt to a part (Press E to ...)", pos: ["path", "action"], flags: { object: "str", hold: ["float", { default: 0 }], distance: ["float", { default: 8 }] } },
  particles: { help: "attach a particle preset to a part", pos: ["path", ["preset", undefined, ["leaves", "sparks", "smoke", "magic", "fire", "snow", "rain", "bubbles", "dust", "confetti", "fireflies"]]], flags: { rate: "float", color: "str" } },
  sign: { help: "place a readable wooden sign", pos: ["text"], flags: { position: "str", parent: "str", size: "str", name: "str" } },
  beam: { help: "glowing beam between two parts", pos: ["from", "to"], flags: { color: "str", width: "float", curve: "float", name: "str" } },
  trail: { help: "motion trail on a moving part", pos: ["path"], flags: { color: "str", lifetime: "float", name: "str" } },
  explosion: { help: "one-shot explosion (visual only)", pos: [], flags: { position: "str", radius: "float" } },
  ui_screen: { help: "create a ScreenGui under StarterGui", pos: ["name"], flags: { parent: "str", order: "int" } },
  ui_frame: { help: "rounded panel/frame", pos: ["parent", "name"], flags: { position: "str", size: "str", anchor: "str", color: "str", transparency: "float", radius: "int", clip: "bool" } },
  ui_label: { help: "text label", pos: ["parent", "name"], flags: { text: "str", position: "str", size: "str", anchor: "str", color: "str", align: "str", font: "str", text_size: "int", wrap: "bool" } },
  ui_button: { help: "text button", pos: ["parent", "name"], flags: { text: "str", position: "str", size: "str", anchor: "str", color: "str", text_color: "str", radius: "int", font: "str", text_size: "int" } },
  ui_input: { help: "TextBox the player can type into", pos: ["parent", "name"], flags: { placeholder: "str", text: "str", position: "str", size: "str", color: "str", background: "str", radius: "int", text_size: "int" } },
  ui_image: { help: "ImageLabel from a Roblox asset id", pos: ["parent", "name"], flags: { asset: "str", position: "str", size: "str", scale: "str" } },
  ui_list: { help: "UIListLayout that auto-arranges a container's children", pos: ["parent"], flags: { direction: "str", padding: "int", halign: "str", valign: "str" } },
  play: { help: "start play-testing the game (client when possible, Run mode fallback)", pos: [], flags: { mode: ["str", { choices: ["play", "run"] }] } },
  stop: { help: "stop the running play test" },
  logs: { help: "read Studio output - errors and warnings from the play test", pos: [], flags: { all: "bool", limit: "int", since: "float" } },
  attr: { help: "read/set/clear Studio attributes on an instance", pos: ["path"], flags: { set: "append", clear: "append" } },
  tag: { help: "add/remove CollectionService tags", pos: [["paths", "+"]], flags: { add: "append", remove: "append" } },
  match: { help: "copy color/material/transparency from one part onto targets", pos: ["from_path", ["to", "+"]] },
  scatter: { help: "scatter N copies of a template in a disc around it", pos: ["path"], flags: { count: ["int", { default: 10 }], radius: ["float", { default: 20 }], y_jitter: ["float", { default: 0 }], parent: "str", name: "str" } },
  terrain: { help: "fill or clear terrain (block or ball)", pos: [], flags: { action: ["str", { choices: ["fill", "clear"], default: "fill" }], shape: ["str", { choices: ["block", "ball"], default: "block" }], position: "str", size: "str", radius: "float", material: ["str", { default: "Grass" }] } },
  search: { help: "search the Roblox Creator Store (models, meshes, images, audio, video, plugins)", pos: ["query"], flags: { category: ["str", { default: "model" }], limit: "int", cursor: "str" }, local: true },
  info: { help: "details + thumbnail for one marketplace asset", pos: ["id"], local: true },
  insert: { help: "insert a marketplace asset into the place", pos: ["id", ["parent", "Workspace"]], flags: { name: "str" } },
  apply: { help: "apply an asset id to a property (Image, Texture, SoundId, MeshId...)", pos: ["id", "path", "prop"] },
};
function stripTimeout(argv) {
  const out = [];
  let timeout = null;
  let ddash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (ddash) { out.push(a); continue; }
    if (a === "--") { ddash = true; out.push(a); continue; }
    if (a === "--timeout" && i + 1 < argv.length) { timeout = parseFloat(argv[++i]); continue; }
    if (a.startsWith("--timeout=")) { timeout = parseFloat(a.slice(10)); continue; }
    out.push(a);
  }
  if (timeout !== null && (!(timeout > 0) || !Number.isFinite(timeout)))
    throw new UsageError("--timeout must be a positive, finite number of seconds");
  return { args: out, timeout };
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
    if (t.startsWith("-") && t.length > 1 && !/^-[\d.]/.test(t)) {
      throw new UsageError(`${name}: unknown flag ${t}`);
    }
    pos.push(t); i++;
  }
  const out = {};
  let pi = 0;
  for (const p of (spec.pos || [])) {
    const a = Array.isArray(p) ? p : [p];
    const pname = a[0], pdef = a[1], pchoices = a[2], ptype = a[3];
    if (pdef === "+") {
      if (pi >= pos.length) throw new UsageError(`${name}: need at least one ${pname}`);
      out[pname] = pos.slice(pi); pi = pos.length;
    } else if (pi < pos.length) {
      const raw = pos[pi++];
      let v = raw;
      if (ptype === "int") { v = parseInt(raw, 10); if (!Number.isInteger(v)) throw new UsageError(`${name}: bad integer for ${pname}: ${raw}`); }
      else if (ptype === "float") { v = parseFloat(raw); if (!Number.isFinite(v)) throw new UsageError(`${name}: bad number for ${pname}: ${raw}`); }
      if (pchoices && !pchoices.includes(ptype ? v : String(v))) throw new UsageError(`${name}: bad ${pname}: ${raw} (need ${pchoices.join("|")})`);
      out[pname] = v;
    } else if (pdef !== undefined) out[pname] = pdef;
    else throw new UsageError(`${name}: missing ${pname}`);
  }
  if (pi < pos.length) throw new UsageError(`${name}: too many arguments (got "${pos[pi]}")`);
  return Object.assign(ns, out);
}
function scalar(s) {
  const t = s.trim();
  if (/^[+-]?\d+$/.test(t)) { const n = parseInt(t, 10); if (Number.isSafeInteger(n)) return n; }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t)) { const f = parseFloat(t); if (Number.isFinite(f)) return f; }
  if (t === "true") return true;
  if (t === "false") return false;
  return s;
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
    case "say":
      return { op: "say", args: { text: ns.text } };
    case "turn": {
      if (ns.action === "begin") return { op: "turn_begin", args: {} };
      if (!ns.note) throw new UsageError('turn end: --note "your reply" is required');
      return { op: "turn_end", args: { note: ns.note } };
    }
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
      return { op: "undo", args: {} };
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
      const a = { path: ns.path, padding: ns.padding };
      if (ns.name) a.name = ns.name;
      if (ns.collide) a.canCollide = true;
      return { op: "hitbox", args: a };
    }
    case "prompt": {
      const a = { path: ns.path, action: ns.action, hold: ns.hold, distance: ns.distance };
      if (ns.object) a.object = ns.object;
      return { op: "prompt", args: a };
    }
    case "particles": {
      const a = { path: ns.path, preset: ns.preset };
      if (ns.rate != null) a.rate = ns.rate;
      if (ns.color) a.color = ns.color;
      return { op: "particles", args: a };
    }
    case "sign": {
      const a = { text: ns.text };
      if (ns.position) a.position = V(ns.position);
      if (ns.parent) a.parent = ns.parent;
      if (ns.size) a.size = V(ns.size);
      if (ns.name) a.name = ns.name;
      return { op: "sign", args: a };
    }
    case "beam": {
      const a = { from: ns.from, to: ns.to };
      for (const k of ["color", "width", "curve", "name"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "beam", args: a };
    }
    case "trail": {
      const a = { path: ns.path };
      for (const k of ["color", "lifetime", "name"]) if (ns[k] != null) a[k] = ns[k];
      return { op: "trail", args: a };
    }
    case "explosion": {
      const a = {};
      if (ns.position) a.position = V(ns.position);
      if (ns.radius != null) a.radius = ns.radius;
      return { op: "explosion", args: a };
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
      const a = {};
      if (ns.mode) a.mode = ns.mode;
      return { op: "play", args: a };
    }
    case "stop":
      return { op: "stop", args: {} };
    case "logs": {
      const a = ns.all ? { filter: "all" } : {};
      if (ns.limit != null) {
        if (ns.limit <= 0) throw new UsageError("logs: --limit must be a positive integer");
        a.limit = ns.limit;
      }
      if (ns.since != null) a.since = ns.since;
      return { op: "logs", args: a };
    }
    case "attr": {
      const a = { path: ns.path };
      if (ns.set && ns.set.length) {
        const o = {};
        for (const kv of ns.set) {
          const e = kv.indexOf("=");
          if (e === -1) throw new UsageError("--set expects K=V");
          const key = kv.slice(0, e);
          if (!key) throw new UsageError("--set expects K=V with a non-empty key");
          o[key] = scalar(kv.slice(e + 1));
        }
        a.set = o;
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
    case "match":
      return { op: "match", args: { from: ns.from_path, paths: ns.to } };
    case "scatter": {
      if (!(ns.count >= 1)) throw new UsageError("scatter: --count must be 1 or greater");
      const a = { path: ns.path, count: ns.count, radius: ns.radius, yJitter: ns.y_jitter };
      if (ns.parent) a.parent = ns.parent;
      if (ns.name) a.name = ns.name;
      return { op: "scatter", args: a };
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
  console.log("  Connect to my Roblox Studio, Run: npx golem-bridge connect <id>");
  console.log("");
  console.log("Session: connect <id> | reconnect [id] | disconnect | manual | help [tool]");
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
  console.log(`${name} - ${spec.help}`);
  console.log("");
  console.log(`Usage: ${toolUsage(name)}`);
  const flags = spec.flags || {};
  const names = Object.keys(flags);
  if (names.length) {
    console.log("");
    console.log("Options:");
    for (const d of names) {
      const fs = flags[d];
      const t = Array.isArray(fs) ? fs[0] : fs;
      const o = Array.isArray(fs) ? (fs[1] || {}) : {};
      let line = `  ${o.flag || "--" + d.replace(/_/g, "-")}`;
      if (t !== "bool") line += ` <${t === "append" ? "value (repeatable)" : "value"}>`;
      if (o.choices) line += ` (${o.choices.join("|")})`;
      if (o.default !== undefined) line += ` [default: ${o.default}]`;
      console.log(line);
    }
  }
}

const MANUAL_FILE = path.join(__dirname, "golem-tools.md");

function printManual() {
  try {
    process.stdout.write(fs.readFileSync(MANUAL_FILE, "utf8").trimEnd() + "\n");
  } catch {
    fail("manual not found next to cli.js - reinstall the package.", 1);
  }
}

async function connect(id, opts) {
  opts = opts || {};
  if (id == null) fail("connect: need the channel id from the Studio widget.", 2);
  if (!isValidChannel(id)) {
    fail("bad channel ID (expect 8-64 hex characters — copy the full line from the Studio widget).", 2);
  }
  const data = await relayCall(id, "ping", {}, opts.timeout || 60);
  if (!data || !data.ok) {
    console.error(JSON.stringify({ ok: false, error: "connect: Studio did not answer. Is the plugin running and the id exact?" }, null, 2));
    process.exitCode = 1;
    return;
  }
  const res = (data && typeof data.result === "object" && data.result) || {};
  const place = res.place || res.placeName || data.place;
  if (!opts.print) {
    const dir = path.join(process.cwd(), ".golem");
    const saved = saveChannel(dir, id);
    console.log(`connected. channel saved to ${saved}`);
    const shadow = envChannelName();
    if (shadow) console.error(`warning: $${shadow} is set - commands will use it instead of this saved channel.`);
  }
  if (place) console.log(`place: ${place}`);
  printManual();
}

async function reconnect(id, opts) {
  opts = opts || {};
  if (opts.print) fail("reconnect: --print is only for connect (reconnect always saves).", 2);
  const saved = loadChannel();
  const target = id || saved;
  if (!target) fail("reconnect: no saved channel and none given.", 2);
  if (!isValidChannel(target)) {
    fail("bad channel ID (expect 8-64 hex characters — copy the full line from the Studio widget).", 2);
  }
  const data = await relayCall(target, "ping", {}, opts.timeout || 60);
  if (!data || !data.ok) {
    console.error(JSON.stringify({ ok: false, error: "reconnect: Studio did not answer." }, null, 2));
    process.exitCode = 1;
    return;
  }
  const res = (data && typeof data.result === "object" && data.result) || {};
  const place = res.place || res.placeName || data.place;
  if (target === saved) {
    console.log("already connected to this channel.");
    if (place) console.log(`place: ${place}`);
    return;
  }
  const dir = path.join(process.cwd(), ".golem");
  const file = saveChannel(dir, target);
  console.log(`reconnected. channel saved to ${file}`);
  const shadow = envChannelName();
  if (shadow) console.error(`warning: $${shadow} is set - commands will use it instead of this saved channel.`);
  if (place) console.log(`place: ${place}`);
}

function disconnect() {
  const dir = path.join(process.cwd(), ".golem");
  let removed = false;
  for (const name of ["channel", ...STALE_HELPER_FILES]) {
    const f = path.join(dir, name);
    try {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed = true; }
    } catch {
      // keep going
    }
  }
  try { fs.rmdirSync(dir); } catch {
    // stays if not empty
  }
  const shadow = envChannelName();
  if (shadow) console.error(`warning: $${shadow} is still set - commands stay connected through the environment.`);
  console.log(removed ? "disconnected (local channel file removed)." : "already disconnected (nothing saved).");
}

// Slow ops need longer minimum waits, but only when the user did not pass an
// explicit --timeout: an explicit timeout is always respected.
const TIMEOUT_MIN = { ping: 60, debug: 90, insert_asset: 300 };

function waitFor(op, timeout) {
  if (timeout != null) return timeout;
  return Math.max(DEFAULT_TIMEOUT, TIMEOUT_MIN[op] || 0);
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
  const channel = requireChannel();
  if (!channel) return;
  const entry = await relayCall(channel, built.op, built.args, waitFor(built.op, timeout));
  out(entry, { asJson: built.asJson, rawField: built.rawField });
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
    if (Object.hasOwn(TOOLS, rest[0])) { toolHelp(rest[0]); return; }
    console.error(`golem-bridge: unknown tool "${rest[0]}"`);
    process.exitCode = 2;
    return;
  }
  if (cmd === "manual") { printManual(); return; }
  if (cmd === "disconnect") { disconnect(); return; }
  if (cmd === "connect" || cmd === "reconnect") {
    let print = false, timeout = null, id = null;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--print") print = true;
      else if (a === "--yes" || a === "-y") { /* accepted for 2.x scripts; nothing to confirm anymore */ }
      else if (a === "--timeout" && k + 1 < rest.length) timeout = parseFloat(rest[++k]);
      else if (a.startsWith("--timeout=")) timeout = parseFloat(a.slice(10));
      else if (!a.startsWith("-") && id === null) id = a;
      else { console.error(`golem-bridge: ${cmd}: bad argument ${a}`); process.exitCode = 2; return; }
    }
    if (timeout != null && (!(timeout > 0) || !Number.isFinite(timeout))) { console.error("golem-bridge: --timeout must be a positive, finite number of seconds"); process.exitCode = 2; return; }
    if (cmd === "connect") await connect(id, { print, timeout });
    else await reconnect(id, { timeout });
    return;
  }
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

module.exports = { TOOLS, GROUPS, parseToolArgs, buildArgs, vec3, scalar, loadChannel, isValidChannel, relayBase, saveChannel, envChannelName, status, mpSearch, mpInfo, relayCall, UsageError, stripTimeout, removeStaleHelpers, disconnect, main };

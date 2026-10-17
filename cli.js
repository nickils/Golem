#!/usr/bin/env node
"use strict";

// golem-bridge: drive a live Roblox Studio session from any AI agent.
// Session setup (connect/reconnect/disconnect) plus the session protocol
// (ping/debug/status/turn/say), all through the Firebase command relay.
// Zero dependencies.

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
function out(data) {
  if (data && data.ok) {
    console.log(JSON.stringify(data, null, 2));
    turnReminder(data);
    process.exitCode = 0;
    return;
  }
  console.error(JSON.stringify(data, null, 2));
  turnReminder(data);
  process.exitCode = 1;
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
  ["Session", ["say", "turn"]],
];

const TOOLS = {
  ping: { help: "health check - is Studio connected?" },
  debug: { help: "diagnostics: relay round-trip, versions, commands served, errors" },
  status: { help: "is the plugin alive or the link revoked? (no Studio needed)", local: true },
  say: { help: "post a message to the user's Studio chat (closes the turn)", pos: ["text"] },
  turn: { help: "mark work turns: begin ... tools ... end --note (required protocol)", pos: [["action", undefined, ["begin", "end"]]], flags: { note: "str" } },
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

function buildArgs(name, ns) {
  switch (name) {
    case "ping":
      return { op: "ping", args: {} };
    case "debug":
      return { op: "debug", args: {} };
    case "say":
      return { op: "say", args: { text: ns.text } };
    case "turn":
      if (ns.action === "begin") return { op: "turn_begin", args: {} };
      if (!ns.note) throw new UsageError('turn end: --note "your reply" is required');
      return { op: "turn_end", args: { note: ns.note } };
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
const TIMEOUT_MIN = { ping: 60, debug: 90 };

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
  out(entry);
}

async function runLocalTool(name, argv) {
  try {
    parseToolInvocation(name, argv);
  } catch (err) {
    if (err instanceof UsageError) { console.error(`golem-bridge: ${err.message}`); process.exitCode = 2; return; }
    throw err;
  }
  if (name === "status") { out(await status()); return; }
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

module.exports = { TOOLS, GROUPS, parseToolArgs, buildArgs, loadChannel, isValidChannel, relayBase, saveChannel, envChannelName, status, relayCall, UsageError, stripTimeout, removeStaleHelpers, disconnect, main };

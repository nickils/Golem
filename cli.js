#!/usr/bin/env node
"use strict";

// golem-bridge: drive a live Roblox Studio session from any AI agent.
//
// v4 connects *directly*: this CLI listens on 127.0.0.1 and the Golem plugin
// polls it over HTTP. There is no relay, no account, no cloud in the middle -
// the AI's terminal command talks to Studio through loopback only.

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const http = require("http");
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

// The bridge lives on loopback by default: a plugin in Studio, and the AI's
// terminal, are both on this machine, so nothing has to cross a network.
// GOLEM_BIND exists only for the cases where the agent is NOT on this machine
// (WSL2/Docker, or an AI harness on another box) - it moves the listener off
// loopback, which is a real security decision, not a convenience toggle.
const DEFAULT_PORT = 41717;
const LOOPBACK = "127.0.0.1";

function bindAddress() {
  const raw = (envOf("GOLEM_BIND") || "").trim();
  if (!raw || raw === LOOPBACK || raw === "localhost") return LOOPBACK;
  if (raw === "0.0.0.0" || raw === "::") return raw;
  // any concrete interface address is allowed; resolve nothing (keep it literal)
  if (/^[0-9a-fA-F:.]+$/.test(raw)) return raw;
  return LOOPBACK;
}

// Advertised base URL. When bound to a wildcard we still hand out loopback to
// this machine's own callers; remote callers use their own host:port.
function bindHostForUrls() {
  const bind = bindAddress();
  return bind === "0.0.0.0" || bind === "::" ? LOOPBACK : bind;
}

function onLoopback() {
  return bindAddress() === LOOPBACK;
}
const PLUGIN_STALE_MS = 20000;
const DEFAULT_TIMEOUT = 120;
// One AI request = one turn. Tools called in a burst share a turn token, so
// the very first call of a request already opens (and reports) its turn.
const TURN_IDLE_MS = Math.max(30000, (parseFloat(envOf("GOLEM_TURN_IDLE")) || 300) * 1000);
// Device ids are minted by the plugin ("golem-" + hex) and are public.
const DEVICE_RE = /^golem-[0-9a-f]{8,64}$/;

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
  const fromEnv = envOf("GOLEM_SECRET");
  if (fromEnv) {
    return { secret: String(fromEnv), port: serverPort(), fromEnv: true };
  }
  const data = readJsonFile(linkFile());
  if (!data || !data.secret) return null;
  return {
    deviceId: data.deviceId,
    secret: data.secret,
    port: data.port || serverPort(),
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
        "not connected - run the setup line shown in the Golem window in Studio: npx golem-bridge connect <secret>",
    });
    return null;
  }
  return link;
}

/**
 * Accepts the setup line from the Studio window - "npx golem-bridge connect
 * <secret>" with an optional "--port N" - or just the secret on its own. The
 * 3.x "<channel>" and "<inbox>:<secret>" shapes are refused with a clear
 * message so an old line never half-works.
 */
function parseSetupLine(text) {
  // Strip surrounding quotes first: users copy from a chat window that may have
  // added them, and the line itself never starts with a quote.
  const raw = String(text == null ? "" : text).trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  const cleaned = raw.replace(/^npx\s+golem-bridge\s+connect\s+/i, "").trim();
  const m = cleaned.match(/^([0-9a-fA-F]{24,128})(?:\s+--port\s+(\d{1,5}))?$/);
  if (!m) {
    if (/^[0-9a-fA-F]{8,64}$/.test(cleaned)) return { legacy: "channel" };
    if (/^[0-9a-fA-F]{8,64}:[0-9a-fA-F]{16,128}$/.test(cleaned)) return { legacy: "pair" };
    return null;
  }
  const parsed = { secret: m[1].toLowerCase() };
  if (m[2]) {
    const port = parseInt(m[2], 10);
    if (!(port > 0) || port > 65535) return null;
    parsed.port = port;
  }
  return parsed;
}

function serverPort() {
  const n = parseInt(envOf("GOLEM_PORT") || "", 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

/**
 * Where THIS process reaches the bridge. Normally loopback. With GOLEM_URL set
 * it points at whatever the user exposed - that is the path for an AI that runs
 * somewhere else and can only reach a tunnel.
 */
function agentBaseUrl() {
  const raw = (envOf("GOLEM_URL") || "").trim().replace(/\/+$/, "");
  if (raw) {
    if (!/^https?:\/\/\S+$/.test(raw)) {
      throw new Error(`GOLEM_URL must be an http(s) URL, got "${raw}"`);
    }
    return raw;
  }
  return serverUrl();
}

function serverUrl(port, host) {
  return `http://${host || bindHostForUrls()}:${port || serverPort()}`;
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

// ------------------------------------------------------------- http to Studio
function httpJson(url, options) {
  const o = options || {};
  const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  const headers = Object.assign({ Accept: "application/json" }, o.headers || {});
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: o.method || (body === undefined ? "GET" : "POST"), headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 64 * 1024 * 1024) {
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.setTimeout(o.timeoutMs || 15000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function serverInfo(port) {
  try {
    const base = agentBaseUrl();
    const r = await httpJson(`${base}/v1/health`, {
      timeoutMs: 2500,
      headers: agentHeaders(),
    });
    return r.json && typeof r.json === "object" && r.json.ok ? r.json : null;
  } catch {
    return null;
  }
}

/**
 * The session secret travels as a header, never in a URL: behind a tunnel the
 * URL ends up in proxy logs and request histories, and the line is already in a
 * chat transcript.
 */
function agentHeaders(extra) {
  const link = (() => {
    try {
      return loadLink();
    } catch {
      return null;
    }
  })();
  const secret = (link && link.secret) || broker.secret || "";
  return Object.assign({}, extra || {}, secret ? { "X-Golem-Secret": secret } : {});
}

/** Ask for commands to run. Long-polls when the CLI is serving. */
async function pollCommands(link, cursor, waitMs) {
  const query = new URLSearchParams({ device: link.deviceId, cursor: cursor || "", wait: String(waitMs || 0) });
  const r = await httpJson(`${agentBaseUrl()}/v1/poll?${query}`, {
    timeoutMs: (waitMs || 0) + 8000,
    headers: { "X-Golem-Secret": link.secret || "" },
  });
  if (r.status !== 200 || !r.json) return null;
  return r.json;
}

async function postResult(link, envelope) {
  const r = await httpJson(`${agentBaseUrl()}/v1/result`, {
    method: "POST",
    body: { device: link.deviceId, secret: link.secret, result: envelope },
    timeoutMs: 15000,
  });
  return r.status === 200;
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

// -------------------------------------------------------------- local broker
// The bridge is a small HTTP server on loopback that the Studio plugin polls.
// It is also the switchboard for the play-test driver: both the plugin and the
// driver that runs inside the game post here, so a screenshot taken in the game
// comes back to the plugin without leaving the machine.
//
//   plugin  --GET  /v1/poll-->  broker  (commands queued by this CLI)
//   plugin  --POST /v1/result-> broker
//   driver  --POST /v1/guest/exec (op=poll)--> broker  (work for the game)
//   plugin  --POST /v1/guest/exec---------> broker --> driver --> back

const broker = {
  secret: "",
  deviceId: null,
  place: null,
  placeId: null,
  pluginVersion: null,
  startedAt: Date.now(),
  lastPluginPoll: 0,
  lastPluginSeen: 0,
  commandsServed: 0,
  errors: 0,
  queue: [],
  pollWaiters: [],
  inflight: new Map(),
  log: [],
  drivers: { client: 0, server: 0 },
  guestQueue: { client: [], server: [] },
  guestPending: new Map(),
  guestWaiters: { client: [], server: [] },
  guestSeq: 0,
};

function brokerLog(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  broker.log.push(`${stamp} ${line}`);
  if (broker.log.length > 200) broker.log.shift();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > (limit || 32 * 1024 * 1024)) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The secret is a capability: it proves the caller holds the setup line. Both
// the plugin (poll) and this CLI (call) must present it.
function authorized(url, headers, body) {
  const presented = [
    url.searchParams.get("secret"),
    headers["x-golem-secret"],
    body && body.secret,
  ];
  // An empty secret only ever happens for a loopback-only listener; off
  // loopback that would mean "everyone is authorized", so refuse instead.
  if (!broker.secret) return onLoopback();
  const ok = presented.some((v) => v === broker.secret);
  if (ok) return true;
  // Only this machine's own helpers (health probe, the in-game driver's own
  // hello/result handshake) may work without it - and only while the listener
  // is bound to loopback. Off-loopback, every route needs the secret.
  return false;
}

/**
 * Is this request coming from this very machine? True for loopback and for any
 * address this host owns - when the listener is bound to a LAN address, Studio
 * and this CLI reach it through that same address, so "own address" has to
 * count as local. Everything else is a remote caller.
 */
function isLocalSocket(req) {
  const addr = (req.socket && req.socket.remoteAddress) || "";
  const plain = addr.replace(/^::ffff:/, "");
  if (plain === "127.0.0.1" || plain === "::1") return true;
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list || []) {
        if (entry && entry.address === plain) return true;
      }
    }
  } catch {
    // no interface info: treat as remote, which is the safe default
  }
  return false;
}

function reply(res, status, data) {
  const body = JSON.stringify(data === undefined ? {} : data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function markPluginSeen() {
  broker.lastPluginPoll = Date.now();
  broker.lastPluginSeen = Date.now();
}

/** Hand one command to the plugin and wait for its result. */
function dispatch(op, args, timeoutSec, extra) {
  return new Promise((resolve) => {
    const id = `c${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const timer = setTimeout(() => {
      if (!broker.inflight.has(id)) return;
      broker.inflight.delete(id);
      resolve({
        id,
        op,
        ok: false,
        error: `Studio did not answer '${op}' within ${timeoutSec}s. Check that the Golem window is open and connected.`,
      });
    }, Math.max(1, timeoutSec) * 1000);
    broker.inflight.set(id, { resolve, timer });
    broker.queue.push(Object.assign({ id, op, args: args || {} }, extra || {}));
    // wake a long-polling plugin immediately instead of waiting for its timer
    const waiters = (broker.pollWaiters || []).splice(0, (broker.pollWaiters || []).length);
    for (const w of waiters) w();
  });
}

/** Ask the in-game driver something (screenshot, click, key press, logs). */
function guestDispatch(role, op, args, timeoutMs) {
  return new Promise((resolve) => {
    const id = `g${(broker.guestSeq += 1)}`;
    const timer = setTimeout(() => {
      broker.guestPending.delete(id);
      resolve({ ok: false, error: `the ${role} driver did not answer within ${Math.round(timeoutMs / 1000)}s - is the play test running?` });
    }, Math.max(1000, timeoutMs || 20000));
    broker.guestPending.set(id, { resolve, timer });
    broker.guestQueue[role] = broker.guestQueue[role] || [];
    broker.guestQueue[role].push({ id, op, args: args || {} });
    const waiters = broker.guestWaiters[role] || [];
    const waiter = waiters.shift();
    if (waiter) waiter();
  });
}

function handleBrokerRequest(req, res, url) {
  const pathname = url.pathname;
  const route = `${req.method} ${pathname}`;

  if (route === "GET /v1/health") {
    // Reachability probe for this machine's own CLI. Off-loopback it would leak
    // the device id and place name to anyone who can hit the port.
    if (!onLoopback() && !isLocalSocket(req)) {
      reply(res, 403, { ok: false, error: "health is local-only" });
      return;
    }
    reply(res, 200, {
      ok: true,
      service: "golem-bridge",
      version: VERSION,
      port: serverPort(),
      bind: bindAddress(),
      loopbackOnly: onLoopback(),
      plugin: { connected: Date.now() - broker.lastPluginPoll < PLUGIN_STALE_MS, lastPollMs: broker.lastPluginPoll },
      place: broker.place,
      deviceId: broker.deviceId,
      drivers: { client: Date.now() - broker.drivers.client < 12000, server: Date.now() - broker.drivers.server < 12000 },
      commandsServed: broker.commandsServed,
      errors: broker.errors,
      uptimeSeconds: Math.floor((Date.now() - broker.startedAt) / 1000),
    });
    return;
  }

  if (route === "POST /v1/session") {
    readBody(req).then((text) => {
      let data = {};
      try {
        data = JSON.parse(text || "{}");
      } catch {
        reply(res, 400, { ok: false, error: "bad JSON" });
        return;
      }
      if (broker.secret && data.secret !== broker.secret) {
        broker.errors += 1;
        brokerLog("rejected a link with the wrong secret");
        reply(res, 403, { ok: false, error: "wrong secret - copy the setup line from the Golem window again" });
        return;
      }
      broker.deviceId = data.deviceId || broker.deviceId;
      broker.place = data.place || broker.place;
      broker.placeId = data.placeId || broker.placeId;
      broker.pluginVersion = data.pluginVersion || broker.pluginVersion;
      markPluginSeen();
      brokerLog(`linked: ${broker.place || "place"} v${broker.pluginVersion || "?"}`);
      reply(res, 200, { ok: true, cursor: String(Date.now()) });
    }).catch(() => reply(res, 400, { ok: false, error: "unreadable body" }));
    return;
  }

  if (route === "GET /v1/poll") {
    if (!authorized(url, req.headers, null)) {
      reply(res, 403, { ok: false, error: "unauthorized" });
      return;
    }
    const device = url.searchParams.get("device") || "";
    if (broker.deviceId && device && device !== broker.deviceId) {
      reply(res, 409, { ok: false, error: "this bridge belongs to another Studio session - run connect again" });
      return;
    }
    if (device) broker.deviceId = broker.deviceId || device;
    markPluginSeen();
    const cursor = url.searchParams.get("cursor") || "";
    const waitMs = Math.min(2500, Math.max(0, parseInt(url.searchParams.get("wait") || "0", 10) || 0));
    const send = () => {
      const commands = broker.queue.splice(0, broker.queue.length);
      for (const c of commands) broker.commandsServed += 1;
      reply(res, 200, { ok: true, cursor: cursor || String(Date.now()), commands });
      if (commands.length && commands.length > 1) brokerLog(`queued ${commands.length} commands`);
    };
    if (broker.queue.length || waitMs === 0) {
      send();
      return;
    }
    // Long poll: answer as soon as work arrives, otherwise say "nothing yet".
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = (broker.pollWaiters || []).indexOf(finish);
      if (idx !== -1) broker.pollWaiters.splice(idx, 1);
      send();
    };
    const timer = setTimeout(finish, waitMs);
    broker.pollWaiters = broker.pollWaiters || [];
    broker.pollWaiters.push(finish);
    return;
  }

  if (route === "POST /v1/result") {
    // Only Studio (same machine) posts command results. A remote caller posting
    // here could forge the answer to a command the AI is waiting on.
    if (!isLocalSocket(req)) {
      reply(res, 403, { ok: false, error: "results are accepted from this machine only" });
      return;
    }
    readBody(req).then((text) => {
      let data = {};
      try {
        data = JSON.parse(text || "{}");
      } catch {
        reply(res, 400, { ok: false, error: "bad JSON" });
        return;
      }
      const envelope = data.result || data;
      const pending = envelope && broker.inflight.get(envelope.id);
      if (pending) {
        clearTimeout(pending.timer);
        broker.inflight.delete(envelope.id);
        pending.resolve(envelope);
      } else {
        brokerLog(`result for unknown command ${envelope && envelope.id}`);
      }
      reply(res, 200, { ok: true });
    }).catch(() => reply(res, 400, { ok: false, error: "unreadable body" }));
    return;
  }

  if (route === "POST /v1/call") {
    // handleBrokerRequest is sync; keep its promise rejection off the stack
    readBody(req).then(async (text) => {
      let data = {};
      try {
        data = JSON.parse(text || "{}");
      } catch {
        reply(res, 400, { ok: false, error: "bad JSON" });
        return;
      }
      if (!authorized(url, req.headers, data)) {
        reply(res, 403, { ok: false, error: "unauthorized - the setup line does not match this bridge" });
        return;
      }
      // The plugin polls continuously, so a command may arrive in the gap
      // between the broker starting and the plugin's next poll: give it a
      // moment instead of failing the call.
      const waitingSince = Date.now();
      while (!broker.deviceId && Date.now() - waitingSince < 4000) {
        await sleep(100);
      }
      if (!broker.deviceId) {
        reply(res, 200, {
          ok: false,
          op: data.op,
          error:
            "Studio is not polling this bridge. Keep the Golem window open - its footer should say connected. If it does, paste the setup line from that window here again so both sides use the same one.",
        });
        return;
      }
      const result = await dispatch(data.op, data.args, data.timeout || DEFAULT_TIMEOUT, { turn: data.turn });
      reply(res, 200, result);
    }).catch((err) => {
      broker.errors += 1;
      brokerLog(`call failed: ${(err && err.message) || err}`);
      if (!res.headersSent) reply(res, 400, { ok: false, error: `unreadable body: ${(err && err.message) || err}` });
    });
    return;
  }

  if (route === "POST /v1/guest/exec") {
    if (!isLocalSocket(req)) {
      reply(res, 403, { ok: false, error: "the in-game driver must be on this machine" });
      return;
    }
    readBody(req).then((text) => {
      let data = {};
      try {
        data = JSON.parse(text || "{}");
      } catch {
        reply(res, 400, { ok: false, error: "bad JSON" });
        return;
      }
      const role = data.role === "server" ? "server" : "client";
      const op = String(data.op || "");

      // the driver inside the game checks in for work
      if (op === "poll") {
        broker.drivers[role] = Date.now();
        const queue = broker.guestQueue[role] || [];
        const item = queue.shift();
        if (item) {
          reply(res, 200, { ok: true, result: { commands: [{ id: item.id, op: item.op, args: item.args }] } });
          return;
        }
        broker.guestWaiters[role] = broker.guestWaiters[role] || [];
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const list = broker.guestWaiters[role] || [];
          const idx = list.indexOf(finish);
          if (idx !== -1) list.splice(idx, 1);
          const next = (broker.guestQueue[role] || []).shift();
          reply(res, 200, {
            ok: true,
            result: { commands: next ? [{ id: next.id, op: next.op, args: next.args }] : [] },
          });
        };
        const timer = setTimeout(finish, 1500);
        broker.guestWaiters[role].push(finish);
        return;
      }

      // the driver reporting back
      if (op === "result") {
        broker.drivers[role] = Date.now();
        const payload = data.args || {};
        const pending = broker.guestPending.get(payload.id);
        if (pending) {
          clearTimeout(pending.timer);
          broker.guestPending.delete(payload.id);
          pending.resolve(payload);
        }
        reply(res, 200, { ok: true });
        return;
      }

      if (op === "hello") {
        const live = Date.now() - (broker.drivers[role] || 0) < 12000;
        reply(res, 200, {
          ok: true,
          result: {
            role,
            live,
            play: live,
            place: broker.place,
            client: role === "client",
          },
        });
        return;
      }

      // a request from the plugin that must run inside the game
      const timeoutMs = Math.min(120000, Math.max(1000, parseInt(data.timeoutMs, 10) || 20000));
      guestDispatch(role, op, data.args || {}, timeoutMs).then((result) => reply(res, 200, result));
    }).catch(() => reply(res, 400, { ok: false, error: "unreadable body" }));
    return;
  }

  reply(res, 404, { ok: false, error: `no route ${route}` });
}

function startBroker(link) {
  broker.secret = link.secret || "";
  if (!broker.secret && !onLoopback()) {
    throw new Error("refusing to listen off loopback without a session secret (GOLEM_SECRET)");
  }
  const port = link.port || serverPort();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, `http://${bindHostForUrls()}:${port}`);
      } catch {
        reply(res, 400, { ok: false, error: "bad request" });
        return;
      }
      try {
        handleBrokerRequest(req, res, url);
      } catch (err) {
        broker.errors += 1;
        reply(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
    });
    // Track live sockets so a one-shot call can shut the listener down without
    // leaving a plugin's long-poll hanging forever.
    const sockets = new Set();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.forceClose = () => {
      for (const socket of sockets) socket.destroy();
    };
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use - another golem-bridge is running, or set GOLEM_PORT`));
      } else {
        reject(err);
      }
    });
    server.listen(port, bindAddress(), () => {
      brokerLog(`listening on ${serverUrl(port)}`);
      resolve({ server, port });
    });
  });
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
  status: { help: "is the plugin reachable from this terminal? (no Studio needed)", local: true },
  cancel: { help: "drop commands still waiting for Studio (after a stuck call)", local: true },
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
  screenshot: { help: "capture the viewport (or the running game) to a PNG", pos: [], flags: { label: "str", max_width: ["int", { flag: "--max-width", default: 900 }] } },
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
  return Object.assign(ns, outNs);
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
  console.log("Direct link - the plugin in Studio talks to this terminal over localhost,");
  console.log("so there is no relay and nothing to sign in to.");
  console.log("");
  console.log("  Start:  paste the setup line from the Golem window in Studio:");
  console.log("          npx golem-bridge connect <secret>");
  console.log("");
  console.log("Session: connect <line> | disconnect | status | cancel | manual | help [tool]");
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

// ------------------------------------------------------------- connection ops
async function status() {
  const link = loadLink();
  const port = link ? link.port : serverPort();
  const health = await serverInfo(port);
  if (!health) {
    return {
      ok: false,
      error: link
        ? `no golem-bridge server is listening on ${serverUrl(port)} - start tools through this CLI (each call serves briefly), or run \`npx golem-bridge connect\` in a terminal that stays open`
        : "not connected - run the setup line from the Golem window: npx golem-bridge connect <secret>",
    };
  }
  const pluginLive = !!(health.plugin && health.plugin.connected);
  return {
    ok: true,
    op: "status",
    result: {
      server: {
        url: process.env.GOLEM_URL ? agentBaseUrl() : serverUrl(port),
        tunnel: !!process.env.GOLEM_URL,
        bind: health.bind,
        loopbackOnly: health.loopbackOnly,
        version: health.version,
        uptimeSeconds: health.uptimeSeconds,
      },
      linked: !!link,
      deviceId: health.deviceId || (link && link.deviceId) || null,
      place: health.place,
      pluginConnected: pluginLive,
      lastPluginPollMsAgo: health.plugin && health.plugin.lastPollMs ? Date.now() - health.plugin.lastPollMs : null,
      drivers: health.drivers,
      commandsServed: health.commandsServed,
      verdict: pluginLive
        ? "Studio is linked and polling - tools will answer"
        : "this bridge is up, but no plugin is polling it. Open the Golem window in Studio and check it says connected; if it does not, paste the setup line there again.",
    },
  };
}

/**
 * A tool call must not host the bridge itself: the plugin only polls in bursts,
 * so the listener has to outlive a single command. `npx golem-bridge __serve`
 * is that detached listener - connect starts it, and any tool call starts it
 * on demand so back-to-back calls in a fresh terminal still work.
 */
function spawnServer(link) {
  const env = Object.assign({}, process.env, {
    GOLEM_PORT: String(link.port || serverPort()),
    GOLEM_SERVE_SECRET: link.secret || "",
  });
  const child = require("child_process").spawn(process.execPath, [__filename, "__serve"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

async function ensureServer(link) {
  const port = link.port || serverPort();
  const health = await serverInfo(port);
  if (health) return;
  spawnServer(link);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(120);
    if (await serverInfo(port)) return;
  }
  throw new Error(`could not start the bridge on ${serverUrl(port)} - run \`npx golem-bridge status\``);
}

async function withServer(link, fn) {
  await ensureServer(link);
  return fn();
}

/** Long-running bridge process; exits when Studio stops polling for a while. */
async function serve(link) {
  const { server, port } = await startBroker(link);
  brokerLog("serving until Studio goes quiet");
  const idleLimitMs = 30 * 60 * 1000;
  const timer = setInterval(() => {
    if (Date.now() - broker.lastPluginSeen > idleLimitMs) {
      clearInterval(timer);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    }
  }, 30000);
  timer.unref();
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  brokerLog(`bridge ready for Studio on ${serverUrl(port)}`);
}

async function runCommand(link, op, args, timeoutSec) {
  const turn = currentTurn();
  return withServer(link, async () => {
    const r = await httpJson(`${agentBaseUrl()}/v1/call`, {
      method: "POST",
      body: { op, args, timeout: timeoutSec, turn: turn.token, device: link.deviceId, secret: link.secret },
      timeoutMs: (timeoutSec + 25) * 1000,
    });
    if (!r.json) {
      return { id: null, op, ok: false, error: `the local bridge did not answer (HTTP ${r.status}). Run \`npx golem-bridge status\`.` };
    }
    return r.json;
  });
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
      "connect: expected the setup line from the Golem window (npx golem-bridge connect <secret>). Copy the whole line.",
      2
    );
  }
  if (parsed.legacy) {
    fail(
      "connect: that is a 3.x line. The 4.x plugin shows a single secret (no channel id, no colon) - copy the line from the updated Golem window.",
      2
    );
  }
  const port = parsed.port || serverPort();
  const link = { secret: parsed.secret, port, deviceId: null };
  const url = serverUrl(port);
  process.stdout.write(`golem-bridge is listening on ${url}\n`);
  if (!onLoopback()) {
    process.stdout.write(
      `  (bound to ${bindAddress()} - reachable from other machines on this network; ` +
        "every call needs the session secret)\n"
    );
  }
  try {
    await ensureServer(link);
  } catch (err) {
    fail(`connect: ${err.message}`, 1);
  }

  const deadline = Date.now() + (o.timeout || 90) * 1000;
  let health = await serverInfo(port);
  process.stderr.write("waiting for Studio to link");
  while (Date.now() < deadline) {
    health = await serverInfo(port);
    if (health && health.deviceId) break;
    process.stderr.write(".");
    await sleep(750);
  }
  process.stderr.write("\n");

  if (!health || !health.deviceId || !(health.plugin && health.plugin.connected)) {
    const saved = saveLink({ secret: parsed.secret, port });
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            "Studio never linked to this terminal. Check that the Golem window is open, that the setup line there matches this one, and that Studio allows this computer's plugin to use HTTP.",
          savedTo: saved,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const saved = saveLink({
    secret: parsed.secret,
    port,
    deviceId: health.deviceId,
    place: health.place,
  });
  // the background bridge needs the real secret, not whatever env it inherited
  spawnServer({ secret: parsed.secret, port });
  console.log(`connected. place: ${health.place || "(unknown)"}`);
  console.log(`saved to ${saved}`);
  if (process.env.GOLEM_URL) {
    console.log(`reaching the bridge through ${agentBaseUrl()} (tunnel mode)`);
  }
  console.log("");
  console.log("Keep this terminal open while the AI works - it is the direct link to Studio.");
  console.log("Every tool call from any other terminal will reach Studio through it.");
  printManual();

  console.log("");
  console.log("The bridge runs in the background, so you can close this terminal and");
  console.log("keep working - `npx golem-bridge disconnect` stops it when you are done.");
  if (o.stay === false) return;
  // Stay attached so the user sees the link is live, until Ctrl+C.
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    setInterval(() => {}, 1 << 30);
  });
  console.log("\nbridge still running in the background (Studio keeps running too).");
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

async function cancelQueued() {
  const link = loadLink();
  const port = link ? link.port : serverPort();
  if (!(await serverInfo(port))) {
    console.log("nothing to cancel - no bridge is running.");
    return;
  }
  const dropped = broker.queue.length + broker.inflight.size;
  for (const [, pending] of broker.inflight) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, op: "cancelled", error: "cancelled by the user" });
  }
  broker.inflight.clear();
  broker.queue.length = 0;
  console.log(dropped ? `dropped ${dropped} queued command(s).` : "nothing was waiting.");
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
  if (cmd === "__serve") {
    const saved = loadLink() || {};
    const link = {
      secret: envOf("GOLEM_SERVE_SECRET") || saved.secret || "",
      port: serverPort(),
    };
    await serve(link);
    return;
  }
  if (cmd === "disconnect") { disconnect(); return; }
  if (cmd === "connect") {
    let timeout = null;
    let line = null;
    let stay = true;
    let portFlag = null;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--timeout" && k + 1 < rest.length) timeout = parseFloat(rest[++k]);
      else if (a.startsWith("--timeout=")) timeout = parseFloat(a.slice(10));
      else if (a === "--no-wait") stay = false;
      else if (a === "--port" && k + 1 < rest.length) portFlag = parseInt(rest[++k], 10);
      else if (a.startsWith("--port=")) portFlag = parseInt(a.slice(7), 10);
      else if (!a.startsWith("-") && line === null) line = a;
      else { console.error(`golem-bridge: connect: bad argument ${a}`); process.exitCode = 2; return; }
    }
    if (timeout != null && (!(timeout > 0) || !Number.isFinite(timeout))) {
      console.error("golem-bridge: --timeout must be a positive, finite number of seconds");
      process.exitCode = 2;
      return;
    }
    if (line === null) fail("connect: need the setup line from the Golem window.", 2);
    if (portFlag != null && (!(portFlag > 0) || portFlag > 65535)) {
      console.error("golem-bridge: --port must be a port number");
      process.exitCode = 2;
      return;
    }
    if (portFlag != null) process.env.GOLEM_PORT = String(portFlag);
    await connect(line, { timeout, stay });
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
  broker,
  startBroker,
  authorized,
  isLocalSocket,
  bindAddress,
  onLoopback,
  agentBaseUrl,
  agentHeaders,
  UsageError,
  main,
};

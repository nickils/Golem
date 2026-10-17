#!/usr/bin/env node
"use strict";

// golem-bridge: drive Roblox Studio through its built-in MCP server.
// Zero dependencies. No plugin, no relay, no saved session.
//
// Every command spawns Studio's own MCP process (StudioMCP on macOS,
// mcp.bat on Windows), speaks newline-delimited JSON-RPC over stdio,
// calls one tool, and exits. Nothing is written to disk.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

let VERSION = "unknown";
try {
  VERSION = require("./package.json").version || "unknown";
} catch {
  // running outside the package dir; version is informational only
}

const MCP_PROTOCOL = "2024-11-05";
const CLIENT_NAME = "golem-bridge";
const INIT_TIMEOUT_MS = 15000;
const TOOLS_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 120000;
const ATTACH_TIMEOUT_SEC = 12;
const ATTACH_POLL_MS = 500;
const MAX_FRAME_CHARS = 16 * 1024 * 1024;
const MAX_TOOL_PAGES = 50;

const STUDIO_ID_ENV = "GOLEM_STUDIO_ID";
const MCP_BIN_ENV = "GOLEM_STUDIO_MCP";
const MCP_BIN_LEGACY_ENV = "ROBLOX_STUDIO_MCP_BIN";

const CLASSIC_SKILLS = [
  ["rbx-create-skill", "Author, edit, or rename an Assistant skill."],
  ["rbx-debug", "Set breakpoints and inspect call stacks, locals, and thread state."],
  ["rbx-device-simulator-lua", "Drive Device Simulator presets, orientation, and UI captures."],
  ["rbx-docs-search", "Retrieve authoritative Roblox API and Creator documentation."],
  ["rbx-perf-profiling", "Read MicroProfiler traces and find CPU, GPU, and memory bottlenecks."],
  ["rbx-scene-analysis", "Audit rendering cost, memory, instance composition, and leaks."],
  ["rbx-unit-test", "Write, run, and debug Luau unit tests (Jest-Lua, TestEZ, or fallback)."],
];

// Logical argument -> the schema property names Studio has used or may use.
const ARG_ALIASES = {
  studio: ["studio_id"],
  code: ["code", "luau", "source", "script", "command"],
  datamodel: ["datamodel_type", "datamodelType", "datamodel", "data_model_type", "context"],
  query: ["query", "keyword", "search", "searchQuery", "searchTerm", "search_term", "term", "q", "text"],
  path: ["path", "instance_path", "instancePath", "target", "root", "scope"],
  depth: ["depth", "max_depth", "maxDepth"],
  className: ["class", "className", "class_name", "type"],
  assetType: ["asset_type", "assetType", "assetTypes", "asset_types", "types", "type", "kind", "category", "assetTypeId"],
  scope: ["scope", "inventory", "source", "creatorScope", "creator_scope"],
  limit: ["limit", "max", "page_size", "pageSize"],
  assetId: ["asset_id", "assetId", "id", "asset", "assetID"],
  parent: ["parent", "parent_path", "parentPath"],
  startLine: ["start_line", "startLine", "from_line", "fromLine", "line_start"],
  endLine: ["end_line", "endLine", "to_line", "toLine", "line_end"],
  pattern: ["pattern", "regex", "search_pattern", "searchPattern"],
  isStart: ["is_start", "isStart", "start", "playing"],
  captureId: ["capture_id", "captureId"],
  skillName: ["name", "skill", "skill_name", "skillName", "id"],
};

class UsageError extends Error {}
class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode || 1;
  }
}
class McpError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function print(text) {
  if (text === undefined || text === null) return;
  process.stdout.write(String(text));
  if (!String(text).endsWith("\n")) process.stdout.write("\n");
}

function printErr(text) {
  if (text === undefined || text === null) return;
  process.stderr.write(String(text));
  if (!String(text).endsWith("\n")) process.stderr.write("\n");
}

// ------------------------------------------------------------------ launch

function commandForPath(file) {
  const resolved = path.resolve(file);
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(resolved)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `cd /d "${path.dirname(resolved)}" && "${resolved}"`],
      display: resolved,
    };
  }
  if (/\.(m?js)$/i.test(resolved)) {
    return { command: process.execPath, args: [resolved], display: resolved };
  }
  return { command: resolved, args: [], display: resolved };
}

function windowsCandidates() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const out = [
    path.join(local, "Roblox", "mcp.bat"),
    path.join(local, "Roblox Studio", "StudioMCP.exe"),
    path.join(local, "Roblox", "StudioMCP.exe"),
  ];
  const versions = path.join(local, "Roblox", "Versions");
  try {
    const dirs = fs
      .readdirSync(versions)
      .filter((name) => name.startsWith("version-"))
      .map((name) => path.join(versions, name, "StudioMCP.exe"))
      .sort()
      .reverse();
    out.push(...dirs);
  } catch {
    // no versions directory
  }
  return out;
}

function resolveMcpCommand() {
  const override = process.env[MCP_BIN_ENV] || process.env[MCP_BIN_LEGACY_ENV];
  if (override) {
    if (!fs.existsSync(override)) {
      throw new CliError(`Studio MCP command not found at ${override} (set by ${MCP_BIN_ENV}).`, 1);
    }
    return commandForPath(override);
  }

  let candidates = [];
  if (process.platform === "darwin") {
    candidates = [
      "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
      path.join(os.homedir(), "Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"),
    ];
  } else if (process.platform === "win32") {
    candidates = windowsCandidates();
  } else {
    throw new CliError(
      "Roblox Studio's MCP server is only available on macOS and Windows. " +
        `On another platform, point ${MCP_BIN_ENV} at a compatible Studio MCP executable.`,
      1
    );
  }

  for (const file of candidates) {
    if (fs.existsSync(file)) return commandForPath(file);
  }
  throw new CliError(
    `Studio MCP was not found. Looked for:\n  ${candidates.join("\n  ")}\n` +
      `Install the latest Roblox Studio, open a place, then enable Assistant > ... > Manage MCP Servers > Enable Studio as MCP server. ` +
      `You can also set ${MCP_BIN_ENV} to the executable path.`,
    1
  );
}

// ------------------------------------------------------------------ MCP client

class McpClient {
  constructor(launch) {
    this.launch = launch;
    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.serverInfo = {};
    this.protocolVersion = "";
  }

  async start(timeoutMs) {
    this.child = spawn(this.launch.command, this.launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.on("error", (err) => {
      this._rejectAll(new McpError(`could not launch Studio MCP (${this.launch.display}): ${err.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      this._rejectAll(new McpError(`Studio MCP closed (${detail}).${this.stderrSuffix()}`));
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this._onLine(line));

    const result = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: VERSION },
      },
      timeoutMs || INIT_TIMEOUT_MS
    );
    this.protocolVersion = String(result.protocolVersion || MCP_PROTOCOL);
    this.serverInfo = result.serverInfo && typeof result.serverInfo === "object" ? result.serverInfo : {};
    this.notify("notifications/initialized");
  }

  stderrSuffix() {
    const tail = this.stderr.trim();
    if (!tail) return "";
    return `\nStudio MCP said:\n${tail.split("\n").slice(-8).join("\n")}`;
  }

  _onLine(line) {
    if (this.closed) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_FRAME_CHARS) {
      this._rejectAll(new McpError("Studio MCP sent a response larger than 16 MB."));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // a log line on stdout is not a protocol frame
    }
    if (!msg || typeof msg !== "object") return;

    // A server request: answer method-not-found so it stops waiting on us.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this._write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      }).catch(() => {});
      return;
    }

    if (msg.id === undefined || msg.id === null || msg.method) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const error = new McpError(String(msg.error.message || "Studio MCP reported an error"));
      error.code = msg.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(msg.result && typeof msg.result === "object" ? msg.result : {});
  }

  _write(message) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new McpError("Studio MCP connection is closed."));
    }
    const line = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  notify(method, params) {
    this._write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }).catch(() => {});
  }

  async request(method, params, timeoutMs) {
    if (this.closed) throw new McpError("Studio MCP connection is closed.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`no response to '${method}' within ${Math.round(timeoutMs / 1000)}s.${this.stderrSuffix()}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: "2.0", id, method, params: params || {} }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`could not send '${method}': ${err.message}`));
      });
    });
  }

  _rejectAll(err) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
    await sleep(100);
    try {
      this.child.kill();
    } catch {
      // already gone
    }
    try {
      this.rl.close();
    } catch {
      // already closed
    }
  }
}

// ------------------------------------------------------------------ MCP helpers

async function listTools(client, timeoutMs) {
  const tools = [];
  let cursor = null;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
    if (!Array.isArray(result.tools)) throw new McpError("Studio MCP returned no tools array.");
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) return tools;
  }
  return tools;
}

async function callTool(client, name, args, timeoutMs) {
  return client.request("tools/call", { name, arguments: args || {} }, timeoutMs);
}

function toolText(result) {
  const parts = [];
  for (const item of (result && result.content) || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "resource" && item.resource && typeof item.resource.text === "string") {
      parts.push(item.resource.text);
    }
  }
  if (!parts.length && result && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n");
}

function toolImages(result) {
  return ((result && result.content) || []).filter((item) => item && item.type === "image" && item.data);
}

function schemaOf(tool) {
  return (tool && tool.inputSchema) || {};
}

function propsOf(tool) {
  return schemaOf(tool).properties || {};
}

function toolNeedsStudio(tool) {
  return Object.prototype.hasOwnProperty.call(propsOf(tool), "studio_id");
}

function formatSchema(tool) {
  const schema = schemaOf(tool);
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const parts = Object.entries(props).map(([name, spec]) => {
    let text = `${name}${required.has(name) ? "*" : ""}`;
    if (spec && spec.type) text += `: ${spec.type}`;
    if (spec && Array.isArray(spec.enum)) text += ` (${spec.enum.join("|")})`;
    return text;
  });
  return parts.join(", ") || "no arguments";
}

function formatToolList(tools) {
  return tools
    .map((tool) => {
      const desc = String(tool.description || "").replace(/\s+/g, " ").trim();
      const head = `${tool.name}\n  args: ${formatSchema(tool)}`;
      return desc ? `${head}\n  ${desc}` : head;
    })
    .join("\n\n");
}

function tokenSet(name) {
  return new Set(
    String(name)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  );
}

function resolveTool(tools, names, expectedArgs) {
  for (const name of names) {
    const exact = tools.find((tool) => String(tool.name).toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }
  const wanted = names.map(tokenSet);
  const candidates = tools.filter((tool) => {
    const tokens = tokenSet(tool.name);
    if (!wanted.some((set) => set.size === tokens.size && [...set].every((token) => tokens.has(token)))) return false;
    if (!expectedArgs || !expectedArgs.length) return true;
    const props = propsOf(tool);
    return expectedArgs.some((arg) => Object.prototype.hasOwnProperty.call(props, arg));
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new CliError(`several Studio tools match ${names.join("/")}: ${candidates.map((tool) => tool.name).join(", ")}`);
  }
  throw new CliError(
    `Studio does not expose a tool matching ${names.join("/")}. Run 'golem-bridge tools' to see the live list.`
  );
}

function pickProperty(tool, aliases) {
  const props = propsOf(tool);
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(props, alias)) return alias;
  }
  return null;
}

function normalizeEnumText(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Studio's marketplace tool accepts a fixed list of asset kinds. Accept
// friendly spellings (image, Image, IMAGES) and return the schema's value.
function coerceEnum(tool, property, value) {
  const spec = propsOf(tool)[property];
  const values = spec && Array.isArray(spec.enum) ? spec.enum : null;
  if (!values) return value;
  const wanted = normalizeEnumText(value);
  const hit = values.find((item) => normalizeEnumText(item) === wanted);
  if (hit !== undefined) return hit;
  if (wanted === "all" || wanted === "any" || wanted === "alltypes") {
    const all = values.find((item) => /^(all|any|alltypes?)$/i.test(normalizeEnumText(item)));
    if (all !== undefined) return all;
  }
  throw new CliError(
    `'${value}' is not an accepted ${property} for ${tool.name}. Use one of: ${values.join(", ")}.`
  );
}

// The value that means "every asset kind" in this Studio version, if any.
function allEnumValue(tool, key) {
  const property = pickProperty(tool, ARG_ALIASES[key] || [key]);
  if (!property) return undefined;
  const spec = propsOf(tool)[property];
  const values = spec && Array.isArray(spec.enum) ? spec.enum : null;
  if (!values) return undefined;
  return values.find((item) => /^(all|any|alltypes?)$/i.test(normalizeEnumText(item)));
}

function buildArgs(tool, logical, studioId) {
  const args = {};
  for (const [key, value] of Object.entries(logical || {})) {
    if (value === undefined || value === null) continue;
    const aliases = ARG_ALIASES[key] || [key];
    const actual = pickProperty(tool, aliases);
    if (!actual) {
      throw new CliError(
        `${tool.name} does not accept '${key}'. Its arguments are: ${formatSchema(tool)}.`
      );
    }
    args[actual] = key === "assetType" || key === "datamodel" ? coerceEnum(tool, actual, value) : value;
  }
  if (studioId && toolNeedsStudio(tool) && args.studio_id === undefined) {
    args.studio_id = studioId;
  }
  const missing = (schemaOf(tool).required || []).filter((name) => args[name] === undefined);
  if (missing.length) {
    throw new CliError(
      `${tool.name} needs ${missing.join(", ")}. Its arguments are: ${formatSchema(tool)}.`
    );
  }
  return args;
}

function parseJsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${label} must be a JSON object`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${label} must be a JSON object`);
  }
  return value;
}

function parseStudios(result) {
  let data = null;
  const text = toolText(result).trim();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (data === null && result && result.structuredContent) data = result.structuredContent;
  if (data === null) return [];

  let entries = data;
  if (!Array.isArray(entries)) {
    entries = data.studios || data.instances || data.roblox_studios || data.items || [];
  }
  if (!Array.isArray(entries)) return [];

  const idKeys = ["studio_id", "id", "studioId", "instance_id"];
  const nameKeys = ["name", "place_name", "placeName", "title", "game_name"];
  const studios = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      studios.push({ id: entry, name: "" });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const id = idKeys.map((key) => entry[key]).find((value) => value !== undefined && value !== null && value !== "");
    if (!id) continue;
    const name = nameKeys.map((key) => entry[key]).find((value) => typeof value === "string" && value);
    studios.push({ id: String(id), name: String(name || "") });
  }
  return studios;
}

function findStudioListTool(tools) {
  return resolveTool(tools, ["list_roblox_studios", "list_studios", "studio_list"], []);
}

async function waitForStudios(client, tools, waitSeconds, callTimeoutMs) {
  const listTool = findStudioListTool(tools);
  const windowMs = Math.max(0, (waitSeconds === undefined ? ATTACH_TIMEOUT_SEC : waitSeconds) * 1000);
  const deadline = Date.now() + windowMs;
  let lastError = "";
  let lastStudios = [];

  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const result = await callTool(client, listTool.name, {}, Math.min(callTimeoutMs, Math.max(1000, remaining)));
      lastStudios = parseStudios(result);
      lastError = "";
      if (lastStudios.length) return { studios: lastStudios, lastError };
    } catch (err) {
      lastError = err.message;
    }
    if (Date.now() >= deadline) return { studios: lastStudios, lastError };
    await sleep(Math.min(ATTACH_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

function resolveStudio(studios, requested) {
  const wanted = requested || process.env[STUDIO_ID_ENV];
  if (wanted) {
    const exact = studios.find((studio) => studio.id === wanted);
    if (exact) return exact.id;
    const byName = studios.filter((studio) => studio.name.toLowerCase() === String(wanted).toLowerCase());
    if (byName.length === 1) return byName[0].id;
    const partial = studios.filter((studio) => studio.name.toLowerCase().includes(String(wanted).toLowerCase()));
    if (partial.length === 1) return partial[0].id;
    if (!studios.length) throw new CliError("no Studio instance is attached");
    throw new CliError(
      `no Studio matches '${wanted}'. Open Studio windows:\n${studios
        .map((studio) => `  ${studio.id}  ${studio.name}`)
        .join("\n")}`
    );
  }
  if (studios.length === 1) return studios[0].id;
  if (!studios.length) throw new CliError("no Studio instance is attached");
  throw new CliError(
    `several Studio windows are open; choose one with --studio <id-or-name>:\n${studios
      .map((studio) => `  ${studio.id}  ${studio.name}`)
      .join("\n")}`
  );
}

function noStudioMessage(lastError) {
  return (
    "Studio did not attach. Check:\n" +
    "  1. Roblox Studio is open with a place loaded.\n" +
    "  2. Assistant > ... > Manage MCP Servers > Enable Studio as MCP server is on.\n" +
    "  3. You are on the latest Studio (macOS or Windows).\n" +
    (lastError ? `Last error: ${lastError}` : "")
  );
}

// ------------------------------------------------------------------ sessions

function timeoutMs(flags, fallback, cap) {
  const value = flags.timeout !== undefined ? flags.timeout : fallback / 1000;
  const ms = Math.max(1, Number(value)) * 1000;
  return cap ? Math.min(ms, cap) : ms;
}

async function withOpen(flags, fn) {
  const launch = resolveMcpCommand();
  const client = new McpClient(launch);
  try {
    await client.start(Math.min(timeoutMs(flags, INIT_TIMEOUT_MS), INIT_TIMEOUT_MS));
    const tools = await listTools(client, Math.min(timeoutMs(flags, TOOLS_TIMEOUT_MS), TOOLS_TIMEOUT_MS));
    return await fn({ client, tools, launch });
  } finally {
    await client.close();
  }
}

async function withStudio(flags, options, fn) {
  return withOpen(flags, async (session) => {
    const { client, tools } = session;
    let studios = [];
    let studioId = null;
    if (options.needStudios !== false) {
      const wait = flags.wait !== undefined ? flags.wait : ATTACH_TIMEOUT_SEC;
      const attached = await waitForStudios(client, tools, wait, timeoutMs(flags, CALL_TIMEOUT_MS));
      studios = attached.studios;
      if (studios.length) {
        studioId = resolveStudio(studios, flags.studio);
      } else if (options.requireStudio !== false) {
        throw new CliError(noStudioMessage(attached.lastError), 1);
      }
    }
    return fn({ ...session, studios, studioId });
  });
}

async function runResolvedTool(flags, spec, fn) {
  return withStudio(flags, { needStudios: true, requireStudio: true }, async (session) => {
    const tool = resolveTool(session.tools, spec.names, spec.expectedArgs || []);
    const logical = typeof spec.logical === "function" ? spec.logical(flags, tool, session.studioId) : spec.logical;
    const args = buildArgs(tool, logical, session.studioId);
    const result = await callTool(session.client, tool.name, args, timeoutMs(flags, CALL_TIMEOUT_MS));
    return fn({ result, tool, args, ...session });
  });
}

function outputResult(result, flags, outPath) {
  const text = toolText(result);
  const images = toolImages(result);
  const written = writeImages(images, outPath);
  if (result && result.isError) {
    const detail = text || "Studio reported an error.";
    throw new CliError(detail + (written.length ? `\nImages: ${written.join(", ")}` : ""), 1);
  }
  if (flags.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (text) print(text);
  if (written.length) print(written.join("\n"));
  if (!text && !written.length) print("(no text returned)");
}

function writeImages(images, outPath) {
  if (!images.length || !outPath) return [];
  const written = [];
  images.forEach((image, index) => {
    const mime = String(image.mimeType || "image/png");
    let ext = ".png";
    if (mime.includes("jpeg")) ext = ".jpg";
    else if (mime.includes("webp")) ext = ".webp";
    let file = outPath;
    if (images.length > 1) {
      const parsed = path.parse(outPath);
      file = path.join(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext || ext}`);
    } else if (!path.extname(file)) {
      file += ext;
    }
    fs.writeFileSync(file, Buffer.from(String(image.data), "base64"));
    written.push(file);
  });
  return written;
}

// ------------------------------------------------------------------ commands

async function cmdConnect(flags, brief) {
  if (flags._pos.length) {
    throw new UsageError(
      "connect takes no channel id anymore. Golem now uses Studio's built-in MCP server; run 'golem-bridge connect' with Studio open."
    );
  }
  return withStudio(flags, { needStudios: true, requireStudio: false }, async (session) => {
    const { client, tools, launch, studios } = session;
    const connected = studios.length > 0;
    if (flags.json) {
      console.log(
        JSON.stringify({
          ok: connected,
          binary: launch.display,
          server: client.serverInfo,
          protocol: client.protocolVersion,
          tools: tools.length,
          studios,
        })
      );
    } else {
      print(`Studio MCP: ${launch.display}`);
      print(
        `Handshake: ${client.serverInfo.name || "StudioMCP"} ${client.serverInfo.version || ""} (protocol ${client.protocolVersion})`
      );
      print(`Tools: ${tools.length}`);
      if (studios.length) {
        for (const studio of studios) print(`Studio: ${studio.id}${studio.name ? `  ${studio.name}` : ""}`);
        print("connected.");
      } else {
        print(noStudioMessage(""));
      }
    }
    if (!connected) {
      process.exitCode = 1;
      return;
    }
    if (!brief && !flags.json) printManual();
  });
}

async function cmdStatus(flags) {
  return withStudio(flags, { needStudios: true, requireStudio: false }, async (session) => {
    const { client, tools, launch, studios } = session;
    const connected = studios.length > 0;
    if (flags.json) {
      console.log(
        JSON.stringify({
          ok: connected,
          binary: launch.display,
          server: client.serverInfo,
          tools: tools.length,
          studios,
        })
      );
    } else if (connected) {
      print(
        `CONNECTED  ${client.serverInfo.name || "StudioMCP"} ${client.serverInfo.version || ""}  ${tools.length} tools  ${studios
          .map((studio) => `${studio.id}${studio.name ? ` (${studio.name})` : ""}`)
          .join(", ")}`
      );
    } else {
      print(noStudioMessage(""));
    }
    if (!connected) process.exitCode = 1;
  });
}

async function cmdStudios(flags) {
  return withStudio(flags, { needStudios: true, requireStudio: false }, async ({ studios }) => {
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, studios }));
      return;
    }
    if (!studios.length) {
      print(noStudioMessage(""));
      process.exitCode = 1;
      return;
    }
    for (const studio of studios) print(`${studio.id}${studio.name ? `  ${studio.name}` : ""}`);
  });
}

async function cmdTools(flags) {
  return withOpen(flags, async ({ tools }) => {
    const wanted = flags._pos[0];
    if (wanted) {
      const tool = tools.find((item) => String(item.name).toLowerCase() === wanted.toLowerCase());
      if (!tool) throw new CliError(`unknown Studio tool '${wanted}'. Run 'golem-bridge tools' for the list.`);
      if (flags.json) {
        console.log(JSON.stringify(tool));
        return;
      }
      print(`${tool.name}`);
      print(tool.description || "");
      print(`arguments: ${formatSchema(tool)}`);
      print(JSON.stringify(schemaOf(tool), null, 2));
      return;
    }
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, tools }));
      return;
    }
    print(formatToolList(tools));
  });
}

async function cmdCall(flags) {
  const name = flags._pos[0];
  if (!name) throw new UsageError("call needs a tool name: golem-bridge call <tool> [json]");
  const rawArgs = flags.args || flags._pos[1] || "{}";
  const args = parseJsonObject(rawArgs, "tool arguments");

  return withOpen(flags, async (session) => {
    const tool = session.tools.find((item) => String(item.name).toLowerCase() === name.toLowerCase());
    if (!tool) throw new CliError(`unknown Studio tool '${name}'. Run 'golem-bridge tools' for the list.`);

    if (toolNeedsStudio(tool) && args.studio_id === undefined) {
      const attached = await waitForStudios(
        session.client,
        session.tools,
        flags.wait !== undefined ? flags.wait : ATTACH_TIMEOUT_SEC,
        timeoutMs(flags, CALL_TIMEOUT_MS)
      );
      if (!attached.studios.length) throw new CliError(noStudioMessage(attached.lastError), 1);
      args.studio_id = resolveStudio(attached.studios, flags.studio);
    }
    const missing = (schemaOf(tool).required || []).filter((key) => args[key] === undefined);
    if (missing.length) {
      throw new CliError(`${tool.name} needs ${missing.join(", ")}. Its arguments are: ${formatSchema(tool)}.`);
    }
    const result = await callTool(session.client, tool.name, args, timeoutMs(flags, CALL_TIMEOUT_MS));
    outputResult(result, flags, flags.out);
  });
}

async function cmdRun(flags) {
  const datamodel = flags.client ? "Client" : flags.server ? "Server" : flags.datamodel || "Edit";
  if (!["Edit", "Client", "Server"].includes(datamodel)) {
    throw new UsageError("--datamodel must be Edit, Client, or Server");
  }
  let code = flags.file ? fs.readFileSync(flags.file, "utf8") : flags._pos[0];
  if (code === undefined || code === "-") {
    if (process.stdin.isTTY) throw new UsageError("run needs Luau code, '-' for stdin, or --file <path>");
    code = fs.readFileSync(0, "utf8");
  }
  if (!code || !String(code).trim()) throw new UsageError("run needs non-empty Luau code");

  return runResolvedTool(
    flags,
    {
      names: ["execute_luau", "run_luau"],
      expectedArgs: ["code", "source", "luau"],
      logical: { code: String(code), datamodel },
    },
    ({ result }) => outputResult(result, flags, flags.out)
  );
}

async function cmdSearch(flags) {
  const query = flags._pos[0];
  if (!query) throw new UsageError('search needs a query: golem-bridge search "low poly tree"');
  if (flags.limit !== undefined && (!(flags.limit > 0) || !Number.isInteger(flags.limit))) {
    throw new UsageError("--limit must be a positive integer");
  }
  return runResolvedTool(
    flags,
    {
      names: ["search_asset", "search_assets"],
      expectedArgs: ["query", "keyword", "search"],
      logical: (searchFlags, tool) => ({
        query,
        assetType: searchFlags.type || allEnumValue(tool, "assetType"),
        scope: searchFlags.scope,
        limit: searchFlags.limit,
      }),
    },
    ({ result }) => outputResult(result, flags, flags.out)
  );
}

async function cmdInsert(flags) {
  const raw = flags._pos[0];
  if (!raw) throw new UsageError("insert needs an asset id: golem-bridge insert 123456");
  const id = String(raw).replace(/^rbxassetid:\/\//i, "");
  if (!/^\d+$/.test(id)) throw new UsageError("asset id must be numeric");
  return runResolvedTool(
    flags,
    {
      names: ["insert_asset", "insert_assets"],
      expectedArgs: ["asset_id", "assetId", "id"],
      logical: { assetId: id, parent: flags.parent },
    },
    ({ result }) => outputResult(result, flags, flags.out)
  );
}

async function cmdSkills(flags) {
  return withStudio(flags, { needStudios: true, requireStudio: true }, async (session) => {
    let result;
    let error = "";
    try {
      const tool = resolveTool(session.tools, ["skill", "skills"], []);
      const args = buildArgs(tool, {}, session.studioId);
      result = await callTool(session.client, tool.name, args, timeoutMs(flags, CALL_TIMEOUT_MS));
      if (result && result.isError) error = toolText(result);
    } catch (err) {
      error = err.message;
    }

    if (flags.json) {
      console.log(
        JSON.stringify({
          ok: !error,
          classic: CLASSIC_SKILLS.map(([name, description]) => ({ name, description })),
          studio: result || null,
          error: error || undefined,
        })
      );
      if (error) process.exitCode = 1;
      return;
    }
    print("Roblox-authored skills (load one with: golem-bridge skill <name>):");
    for (const [name, description] of CLASSIC_SKILLS) print(`  ${name} - ${description}`);
    if (result && !error) {
      const live = toolText(result).trim();
      if (live) {
        print("");
        print(live);
      }
    } else if (error) {
      print("");
      print(`Studio's skill tool did not list skills: ${error}`);
      process.exitCode = 1;
    }
  });
}

async function cmdSkill(flags) {
  if (!flags._pos[0]) return cmdSkills(flags);
  const name = flags._pos[0];
  return withStudio(flags, { needStudios: true, requireStudio: true }, async (session) => {
    const tool = resolveTool(session.tools, ["skill", "skills"], []);
    const args = buildArgs(tool, { skillName: name }, session.studioId);
    const result = await callTool(session.client, tool.name, args, timeoutMs(flags, CALL_TIMEOUT_MS));
    outputResult(result, flags, flags.out);
  });
}

function simpleCommand(spec) {
  return async function run(flags) {
    const logical = spec.logical ? spec.logical(flags) : {};
    return runResolvedTool(
      flags,
      {
        names: spec.names,
        expectedArgs: spec.expectedArgs || [],
        logical,
      },
      ({ result }) => outputResult(result, flags, flags.out)
    );
  };
}

const cmdTree = simpleCommand({
  names: ["search_game_tree", "tree"],
  expectedArgs: ["path"],
  logical: (flags) => ({
    path: flags._pos[0] || "game",
    depth: flags.depth,
    className: flags.class,
  }),
});

const cmdInspect = simpleCommand({
  names: ["inspect_instance", "inspect"],
  expectedArgs: ["path"],
  logical: (flags) => ({ path: flags._pos[0] }),
});

const cmdRead = simpleCommand({
  names: ["script_read", "read_script"],
  expectedArgs: ["path"],
  logical: (flags) => ({
    path: flags._pos[0],
    startLine: flags.start,
    endLine: flags.end,
  }),
});

const cmdFind = simpleCommand({
  names: ["script_search", "find_script"],
  expectedArgs: ["query"],
  logical: (flags) => ({ query: flags._pos[0] }),
});

const cmdGrep = simpleCommand({
  names: ["script_grep", "grep_scripts"],
  expectedArgs: ["pattern"],
  logical: (flags) => ({ pattern: flags._pos[0] }),
});

const cmdState = simpleCommand({
  names: ["get_studio_state", "studio_state"],
});

const cmdPlay = simpleCommand({
  names: ["start_stop_play", "playtest"],
  expectedArgs: ["is_start"],
  logical: () => ({ isStart: true }),
});

const cmdStop = simpleCommand({
  names: ["start_stop_play", "playtest"],
  expectedArgs: ["is_start"],
  logical: () => ({ isStart: false }),
});

const cmdLogs = simpleCommand({
  names: ["get_console_output", "console_output"],
});

async function cmdScreenshot(flags) {
  const out = flags.out || "studio-capture.png";
  return runResolvedTool(
    flags,
    {
      names: ["screen_capture", "screenshot"],
      expectedArgs: ["capture_id"],
      logical: () => ({
        captureId: `golem-${Date.now().toString(36)}`,
      }),
    },
    ({ result }) => outputResult(result, flags, out)
  );
}

// ------------------------------------------------------------------ parsing

const COMMON_FLAGS = {
  json: { type: "bool" },
  studio: { type: "str" },
  timeout: { type: "float" },
  wait: { type: "float" },
};

function parseFlags(argv, spec) {
  const flags = { _pos: [] };
  const merged = { ...COMMON_FLAGS, ...spec };
  let i = 0;
  let ddash = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (ddash) {
      flags._pos.push(arg);
      i++;
      continue;
    }
    if (arg === "--") {
      ddash = true;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
      const def = merged[key];
      if (!def) throw new UsageError(`unknown option --${key}`);
      const dest = def.dest || key;
      if (def.type === "bool") {
        if (eq !== -1) throw new UsageError(`--${key} takes no value`);
        flags[dest] = true;
        i++;
        continue;
      }
      let raw;
      if (eq !== -1) raw = arg.slice(eq + 1);
      else {
        i++;
        if (i >= argv.length) throw new UsageError(`--${key} needs a value`);
        raw = argv[i];
      }
      if (def.type === "int") {
        if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${key} must be an integer`);
        flags[dest] = parseInt(raw, 10);
      } else if (def.type === "float") {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${key} must be a positive number`);
        flags[dest] = value;
      } else {
        flags[dest] = raw;
      }
      i++;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option ${arg}`);
    flags._pos.push(arg);
    i++;
  }
  if (flags.wait !== undefined && flags.wait < 0) throw new UsageError("--wait cannot be negative");
  if (flags.timeout !== undefined && flags.timeout <= 0) throw new UsageError("--timeout must be a positive number");
  return flags;
}

const COMMAND_SPECS = {
  connect: {
    help: "verify Studio and print the agent manual (no files written)",
    flags: { brief: { type: "bool" } },
    run: (flags) => cmdConnect(flags, flags.brief),
  },
  doctor: {
    help: "same as connect --brief",
    flags: {},
    run: (flags) => cmdConnect(flags, true),
  },
  status: { help: "short connection check", flags: {}, run: cmdStatus },
  ping: { help: "alias for status", flags: {}, run: cmdStatus },
  studios: { help: "list open Studio windows", flags: {}, run: cmdStudios },
  tools: {
    help: "list Studio MCP tools, or show one tool's schema",
    flags: {},
    run: cmdTools,
  },
  call: {
    help: "call any Studio MCP tool: call <tool> [json]",
    flags: { args: { type: "str" }, out: { type: "str" } },
    run: cmdCall,
  },
  run: {
    help: "run Luau like the Studio console",
    flags: {
      file: { type: "str" },
      datamodel: { type: "str" },
      client: { type: "bool" },
      server: { type: "bool" },
      out: { type: "str" },
    },
    run: cmdRun,
  },
  search: {
    help: "search the market: models, images, audio, video, meshes, and more",
    flags: {
      type: { type: "str" },
      "asset-type": { type: "str", dest: "type" },
      scope: { type: "str" },
      limit: { type: "int" },
      out: { type: "str" },
    },
    run: cmdSearch,
  },
  insert: {
    help: "insert a marketplace asset by id",
    flags: { parent: { type: "str" }, out: { type: "str" } },
    run: cmdInsert,
  },
  skills: { help: "list Roblox-authored skills", flags: {}, run: cmdSkills },
  skill: {
    help: "load a Roblox-authored skill (rbx-debug, rbx-unit-test, ...)",
    flags: { out: { type: "str" } },
    run: cmdSkill,
  },
  tree: {
    help: "explore the instance tree",
    flags: { depth: { type: "int" }, class: { type: "str" }, out: { type: "str" } },
    run: cmdTree,
  },
  inspect: {
    help: "inspect one instance and its properties",
    flags: { out: { type: "str" } },
    run: cmdInspect,
  },
  read: {
    help: "read a script",
    flags: {
      start: { type: "int", dest: "start" },
      end: { type: "int", dest: "end" },
      out: { type: "str" },
    },
    run: cmdRead,
  },
  find: {
    help: "find scripts by name",
    flags: { out: { type: "str" } },
    run: cmdFind,
  },
  grep: {
    help: "search inside scripts",
    flags: { out: { type: "str" } },
    run: cmdGrep,
  },
  state: { help: "Studio play state and datamodel availability", flags: {}, run: cmdState },
  play: { help: "start playtesting", flags: {}, run: cmdPlay },
  stop: { help: "stop playtesting", flags: {}, run: cmdStop },
  logs: { help: "read Studio console output", flags: {}, run: cmdLogs },
  screenshot: {
    help: "capture the Studio viewport",
    flags: { out: { type: "str" } },
    run: cmdScreenshot,
  },
  manual: { help: "print the full agent manual", flags: {}, run: () => printManual() },
};

function toolUsage(name, spec) {
  const parts = [`npx golem-bridge ${name}`];
  if (name === "call") parts.push("<tool> [json]");
  else if (name === "run") parts.push("<code|->");
  else if (name === "search") parts.push("<query>");
  else if (name === "insert") parts.push("<asset-id>");
  else if (name === "skill") parts.push("[name]");
  else if (["tree", "inspect", "read", "find", "grep"].includes(name)) parts.push("<path-or-query>");
  if (spec.flags && Object.keys(spec.flags).length) parts.push("[options]");
  return parts.join(" ");
}

function printHelp() {
  print("golem-bridge: drive Roblox Studio through its built-in MCP server.");
  print("");
  print("  Setup: open Studio, enable Assistant > ... > Manage MCP Servers > Enable Studio as MCP server.");
  print("  Nothing is installed in Studio and no session files are written.");
  print("");
  print("Usage: npx golem-bridge <command> [options]");
  print("");
  const groups = [
    ["Connection", ["connect", "doctor", "status", "studios", "tools"]],
    ["Studio", ["run", "tree", "inspect", "read", "find", "grep", "state", "play", "stop", "logs", "screenshot"]],
    ["Marketplace", ["search", "insert"]],
    ["Skills", ["skills", "skill"]],
    ["Generic", ["call", "manual"]],
  ];
  for (const [group, names] of groups) {
    print(`${group}:`);
    for (const name of names) print(`  ${name} - ${COMMAND_SPECS[name].help}`);
    print("");
  }
  print("Options: --studio <id|name>  --json  --timeout <seconds>  --wait <seconds>");
  print("See one command: npx golem-bridge help <command>.");
}

function printCommandHelp(name) {
  const spec = COMMAND_SPECS[name];
  if (!spec) {
    printErr(`golem-bridge: unknown command "${name}"`);
    process.exitCode = 2;
    return;
  }
  print(`${name} - ${spec.help}`);
  print("");
  print(`Usage: ${toolUsage(name, spec)}`);
  const flags = spec.flags || {};
  if (Object.keys(flags).length) {
    print("");
    print("Options:");
    for (const [key, def] of Object.entries(flags)) {
      if (key === def.dest) continue;
      print(`  --${key}${def.type === "bool" ? "" : ` <${def.type}>`}`);
    }
  }
  print("  --studio <id|name>   choose a Studio window when several are open");
  print("  --json               print the raw MCP result");
  print("  --timeout <seconds>  per-request timeout");
  print("  --wait <seconds>     how long to wait for Studio to attach (default 12)");
}

const MANUAL_FILE = path.join(__dirname, "golem-tools.md");

function printManual() {
  try {
    process.stdout.write(fs.readFileSync(MANUAL_FILE, "utf8").trimEnd() + "\n");
  } catch {
    throw new CliError("manual not found next to cli.js - reinstall the package.", 1);
  }
}

// ------------------------------------------------------------------ main

async function main(argv) {
  const args = argv || process.argv.slice(2);
  if (!args.length) {
    printHelp();
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    print(VERSION);
    return;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }
  if (args[0] === "help") {
    if (args[1]) printCommandHelp(args[1]);
    else printHelp();
    return;
  }
  if (args[0] === "reconnect" || args[0] === "disconnect") {
    throw new UsageError(
      `${args[0]} is gone: Golem no longer keeps a channel or a session. Every command connects to Studio's built-in MCP server directly.`
    );
  }

  const name = args[0];
  const spec = COMMAND_SPECS[name];
  if (!spec) {
    printErr(`golem-bridge: unknown command "${name}" (try: help)`);
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(args.slice(1), spec.flags || {});
  if (flags.help) {
    printCommandHelp(name);
    return;
  }
  await spec.run(flags);
}

if (require.main === module) {
  main().catch((err) => {
    const code = err instanceof UsageError ? 2 : err.exitCode || 1;
    printErr(`golem-bridge: ${err.message}`);
    process.exitCode = code;
  });
}

module.exports = {
  CLASSIC_SKILLS,
  McpClient,
  UsageError,
  buildArgs,
  callTool,
  commandForPath,
  formatSchema,
  listTools,
  main,
  parseFlags,
  parseStudios,
  resolveStudio,
  resolveTool,
  tokenSet,
};

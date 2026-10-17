#!/usr/bin/env node
"use strict";

// A fake Roblox Studio MCP server for tests.
//
// Speaks the same newline-delimited JSON-RPC 2.0 protocol as Studio's
// StudioMCP binary. Behaviour is selected with FAKE_MCP_MODE:
//   normal (default) - one studio, paginated tool list
//   nostudio         - handshake works, no studio instance attached
//   multi            - two studio windows open
//   late             - studio appears 1.2s after launch
//   silent           - tools/list never answers
//   crash            - the binary dies on startup
//   toolerror        - execute_luau returns an isError result
//   legacy           - older tool schemas with different argument names

const MODE = process.env.FAKE_MCP_MODE || "normal";
const START = Date.now();

if (MODE === "crash") process.exit(3);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\n");
    if (at === -1) break;
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function text(value, isError) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

const LEGACY = MODE === "legacy";

const TOOLS = [
  {
    name: "list_roblox_studios",
    description: "List open Roblox Studio windows.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: () => {
      if (MODE === "nostudio") return text('{"studios":[]}');
      if (MODE === "late" && Date.now() - START < 1200) return text('{"studios":[]}');
      if (MODE === "multi") {
        return text(
          JSON.stringify({
            studios: [
              { id: "studio-abc", name: "Test Place" },
              { id: "studio-2", name: "Second Place" },
            ],
          })
        );
      }
      return text(JSON.stringify({ studios: [{ id: "studio-abc", name: "Test Place" }] }));
    },
  },
];

const SCHEMA = {
  list_roblox_studios: { type: "object", properties: {}, required: [] },
  execute_luau: {
    type: "object",
    properties: {
      code: { type: "string" },
      datamodel_type: { type: "string", enum: ["Edit", "Client", "Server"] },
      studio_id: { type: "string" },
    },
    required: ["code", "studio_id"],
  },
  search_asset: {
    type: "object",
    properties: {
      query: { type: "string" },
      asset_type: { type: "string" },
      scope: { type: "string" },
      limit: { type: "number" },
      studio_id: { type: "string" },
    },
    required: ["query", "studio_id"],
  },
  insert_asset: {
    type: "object",
    properties: {
      asset_id: { type: "string" },
      parent: { type: "string" },
      studio_id: { type: "string" },
    },
    required: ["asset_id", "studio_id"],
  },
  skill: {
    type: "object",
    properties: { name: { type: "string" }, studio_id: { type: "string" } },
    required: ["studio_id"],
  },
  search_game_tree: {
    type: "object",
    properties: { path: { type: "string" }, depth: { type: "number" }, studio_id: { type: "string" } },
    required: ["studio_id"],
  },
  inspect_instance: {
    type: "object",
    properties: { path: { type: "string" }, studio_id: { type: "string" } },
    required: ["path", "studio_id"],
  },
  script_read: {
    type: "object",
    properties: {
      path: { type: "string" },
      start_line: { type: "number" },
      end_line: { type: "number" },
      studio_id: { type: "string" },
    },
    required: ["path", "studio_id"],
  },
  script_search: {
    type: "object",
    properties: { query: { type: "string" }, studio_id: { type: "string" } },
    required: ["query", "studio_id"],
  },
  script_grep: {
    type: "object",
    properties: { pattern: { type: "string" }, studio_id: { type: "string" } },
    required: ["pattern", "studio_id"],
  },
  get_studio_state: {
    type: "object",
    properties: { studio_id: { type: "string" } },
    required: ["studio_id"],
  },
  start_stop_play: {
    type: "object",
    properties: { is_start: { type: "boolean" }, studio_id: { type: "string" } },
    required: ["is_start", "studio_id"],
  },
  get_console_output: {
    type: "object",
    properties: { studio_id: { type: "string" } },
    required: ["studio_id"],
  },
  screen_capture: {
    type: "object",
    properties: { capture_id: { type: "string" }, studio_id: { type: "string" } },
    required: ["capture_id", "studio_id"],
  },
  multi_edit: {
    type: "object",
    properties: { path: { type: "string" }, source: { type: "string" }, studio_id: { type: "string" } },
    required: ["path", "source", "studio_id"],
  },
};

if (LEGACY) {
  SCHEMA.execute_luau = {
    type: "object",
    properties: {
      luau: { type: "string" },
      datamodel: { type: "string", enum: ["Edit", "Client", "Server"] },
      studio_id: { type: "string" },
    },
    required: ["luau", "studio_id"],
  };
  SCHEMA.search_asset = {
    type: "object",
    properties: { q: { type: "string" }, studio_id: { type: "string" } },
    required: ["q", "studio_id"],
  };
  SCHEMA.insert_asset = {
    type: "object",
    properties: { assetId: { type: "string" }, studio_id: { type: "string" } },
    required: ["assetId", "studio_id"],
  };
  SCHEMA.skill = {
    type: "object",
    properties: { id: { type: "string" }, studio_id: { type: "string" } },
    required: ["studio_id"],
  };
}

for (const tool of TOOLS) tool.inputSchema = SCHEMA[tool.name];

for (const name of Object.keys(SCHEMA)) {
  if (TOOLS.some((tool) => tool.name === name)) continue;
  TOOLS.push({
    name,
    description: `Fake ${name}.`,
    inputSchema: SCHEMA[name],
    run: (args) => runTool(name, args),
  });
}

function runTool(name, args) {
  if (name === "execute_luau") {
    if (MODE === "toolerror") return text("boom: Luau failed", true);
    const code = args.code !== undefined ? args.code : args.luau;
    return text(`datamodel=${args.datamodel_type || args.datamodel}\nstudio=${args.studio_id}\ncode=${code}`);
  }
  if (name === "search_asset") {
    const query = args.query !== undefined ? args.query : args.q;
    return text(JSON.stringify({ query, type: args.asset_type, scope: args.scope, limit: args.limit }));
  }
  if (name === "insert_asset") {
    const id = args.asset_id !== undefined ? args.asset_id : args.assetId;
    return text(`inserted ${id} under ${args.parent || "Selection"}`);
  }
  if (name === "skill") {
    const requested = args.name !== undefined ? args.name : args.id;
    if (!requested) return text("skills: rbx-debug, rbx-unit-test");
    return text(`SKILL:${requested}`);
  }
  if (name === "screen_capture") {
    return {
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  return text(`${name}(${JSON.stringify(args)})`);
}

function missingArgs(tool, args) {
  const required = (tool.inputSchema.required || []).slice();
  return required.filter((key) => args[key] === undefined);
}

function handle(msg) {
  const { id, method } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "FakeStudioMCP", version: "9.9.9" },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    if (MODE === "silent") return;
    const perPage = 4;
    const cursor = msg.params && msg.params.cursor ? parseInt(msg.params.cursor, 10) || 0 : 0;
    const page = TOOLS.slice(cursor, cursor + perPage).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const next = cursor + perPage;
    return reply(id, {
      tools: page,
      ...(next < TOOLS.length ? { nextCursor: String(next) } : {}),
    });
  }
  if (method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const tool = TOOLS.find((item) => item.name === name);
    if (!tool) return reply(id, text(`unknown tool ${name}`, true));
    const missing = missingArgs(tool, args);
    if (missing.length) return reply(id, text(`BAD ARGS: missing ${missing.join(",")}`, true));
    if (args.studio_id !== undefined && !["studio-abc", "studio-2"].includes(args.studio_id)) {
      return reply(id, text(`no Studio with id ${args.studio_id}`, true));
    }
    try {
      return reply(id, tool.run(args));
    } catch (err) {
      return reply(id, text(String(err && err.message), true));
    }
  }
  if (id !== undefined && id !== null) fail(id, `unknown method ${method}`);
}
